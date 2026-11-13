// Channel-scoped DEX swap monitor for EVM token contracts.
// Uses public JSON-RPC + DexScreener pair discovery; no paid indexer/API key required.
import { db } from "./db.js";
import { EVM, rpc } from "./balances.js";

const DEX_CHAIN = { ethereum:"ethereum", bsc:"bsc", polygon:"polygon", arbitrum:"arbitrum", base:"base", optimism:"optimism", avalanche:"avax" };
const EXPLORER = { ethereum:"https://etherscan.io", bsc:"https://bscscan.com", polygon:"https://polygonscan.com", arbitrum:"https://arbiscan.io", base:"https://basescan.org", optimism:"https://optimistic.etherscan.io", avalanche:"https://snowtrace.io" };
const V2 = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const V3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const addrTopic = x => "0x" + String(x || "").replace(/^0x/, "").slice(-40);
const rpcUrl = n => process.env["RPC_"+n.toUpperCase()] || EVM[n].rpc;
const esc = s => String(s ?? "").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const short = a => a ? a.slice(0,6)+"…"+a.slice(-4) : "—";
const fmt = n => Number(n || 0).toLocaleString("en-US",{maximumFractionDigits:6});
const NET_NAME = { ethereum:"Ethereum", bsc:"BNB Chain", polygon:"Polygon", arbitrum:"Arbitrum", base:"Base", optimism:"Optimism", avalanche:"Avalanche" };
const dexGet = async url => { const r=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(8000)}); if(!r.ok) throw new Error("DEX_DISCOVERY_"+r.status); return r.json(); };

async function tokenMeta(network,address) {
  const url=rpcUrl(network), call=async data=>rpc(url,"eth_call",[{to:address,data},"latest"]);
  const decode = hex => { try { const h=hex.slice(2), off=parseInt(h.slice(0,64),16)*2, len=parseInt(h.slice(off,off+64),16); return Buffer.from(h.slice(off+64,off+64+Math.min(len,128)*2),"hex").toString("utf8").replace(/[^\x20-\x7e]/g,"").trim().slice(0,40) || Buffer.from(h.slice(0,64),"hex").toString("utf8").replace(/\0/g,"").trim().slice(0,40); } catch { return ""; } };
  const [decHex,nameHex,symbolHex]=await Promise.all([call("0x313ce567").catch(()=>null),call("0x06fdde03").catch(()=>null),call("0x95d89d41").catch(()=>null)]);
  const decimals=decHex===null?18:parseInt(decHex,16), name=decode(nameHex||"")||"Token", symbol=decode(symbolHex||"")||"TOKEN";
  return {decimals:Number.isFinite(decimals)&&decimals>=0&&decimals<=36?decimals:18,name,symbol};
}

async function discover(w) {
  const chain=DEX_CHAIN[w.network];
  const pairs=await dexGet(`https://api.dexscreener.com/token-pairs/v1/${chain}/${w.token_address}`);
  const valid=(Array.isArray(pairs)?pairs:[]).filter(p=>p.pairAddress && p.chainId===chain && ((p.baseToken?.address||"").toLowerCase()===w.token_norm || (p.quoteToken?.address||"").toLowerCase()===w.token_norm) && Number(p.liquidity?.usd||0)>0);
  valid.sort((a,b)=>Number(b.liquidity?.usd||0)-Number(a.liquidity?.usd||0));
  const p=valid[0]; if(!p) throw new Error("NO_LIQUIDITY_PAIR_FOUND");
  const url=rpcUrl(w.network);
  const [t0,t1,block]=await Promise.all([
    rpc(url,"eth_call",[{to:p.pairAddress,data:"0x0dfe1681"},"latest"]),
    rpc(url,"eth_call",[{to:p.pairAddress,data:"0xd21220a7"},"latest"]),
    rpc(url,"eth_blockNumber",[])
  ]);
  const token0="0x"+t0.slice(-40), token1="0x"+t1.slice(-40);
  const meta=await tokenMeta(w.network,w.token_address);
  // Uniswap-V3-compatible pools expose fee(); fall back to recent event signatures for other DEXes.
  const latest=parseInt(block,16), from=Math.max(0,latest-5000);
  let version="v2", v3Fee=false;
  try { const fee=await rpc(url,"eth_call",[{to:p.pairAddress,data:"0xddca3f43"},"latest"]); v3Fee=!!fee && BigInt(fee)>0n; } catch {}
  if(v3Fee) version="v3";
  else {
    const probe=async topic=>rpc(url,"eth_getLogs",[{address:p.pairAddress,fromBlock:"0x"+from.toString(16),toBlock:"latest",topics:[topic]}]);
    try { const logs=await probe(V3); if(logs.length)version="v3"; else { const v2logs=await probe(V2); if(!v2logs.length) throw new Error("PAIR_SWAP_EVENTS_NOT_FOUND"); } }
    catch(e) { if(String(e.message).includes("PAIR_SWAP_EVENTS_NOT_FOUND"))throw e; throw new Error("PAIR_TYPE_DETECTION_FAILED"); }
  }
  return {pair:p.pairAddress,token0,token1,version,block:latest,meta,priceUsd:Number(p.priceUsd||0),quoteSymbol:p.quoteToken?.symbol||"QUOTE"};
}

async function processWatch(w) {
  const url=rpcUrl(w.network);
  let watch=w;
  if(!w.pair_address) {
    const d=await discover(w);
    await db().query(`UPDATE community_contract_watches SET pair_address=$2,pair_version=$3,token0=$4,token1=$5,last_block=$6,token_name=$7,token_symbol=$8,status='active',last_error=NULL,updated_at=NOW() WHERE id=$1`,[w.id,d.pair,d.version,d.token0,d.token1,d.block,d.meta.name,d.meta.symbol]);
    return {discovered:true,trades:0}; // start at current block; no historic spam
  }
  const latest=parseInt(await rpc(url,"eth_blockNumber",[]),16), from=Number(w.last_block||latest-1)+1, to=Math.min(latest,from+499);
  if(from>to)return {trades:0};
  const topic=w.pair_version==="v3"?V3:V2;
  const logs=await rpc(url,"eth_getLogs",[{address:w.pair_address,fromBlock:"0x"+from.toString(16),toBlock:"0x"+to.toString(16),topics:[topic]}]);
  const tokenIs0=w.token0.toLowerCase()===w.token_norm;
  const meta=await tokenMeta(w.network,w.token_address);
  const quoteMeta=await tokenMeta(w.network,tokenIs0?w.token1:w.token0);
  let sent=0, scannedTo=to;
  for(const l of logs) {
    let side,tokenRaw,quoteRaw,trader;
    if(w.pair_version==="v2") {
      const d=l.data.slice(2), a0i=BigInt("0x"+d.slice(0,64)),a1i=BigInt("0x"+d.slice(64,128)),a0o=BigInt("0x"+d.slice(128,192)),a1o=BigInt("0x"+d.slice(192,256));
      const ti=tokenIs0?a0i:a1i,tox=tokenIs0?a0o:a1o, qi=tokenIs0?a1i:a0i,qo=tokenIs0?a1o:a0o;
      if(tox>0n && ti===0n){side="BUY";tokenRaw=tox;quoteRaw=qi;} else if(ti>0n && tox===0n){side="SELL";tokenRaw=ti;quoteRaw=qo;} else continue;
      trader=addrTopic(l.topics?.[2]);
    } else {
      const d=l.data.slice(2), signed=x=>{const n=BigInt("0x"+x);return n>(1n<<255n)-1n?n-(1n<<256n):n;};
      const a0=signed(d.slice(0,64)),a1=signed(d.slice(64,128)), target=tokenIs0?a0:a1, quote=tokenIs0?a1:a0;
      if(target>0n){side="SELL";tokenRaw=target;quoteRaw=quote<0n?-quote:quote;} else if(target<0n){side="BUY";tokenRaw=-target;quoteRaw=quote<0n?-quote:quote;} else continue;
      trader=addrTopic(l.topics?.[2]);
    }
    const tokenAmount=Number(tokenRaw)/10**meta.decimals, quoteAmount=Number(quoteRaw)/10**quoteMeta.decimals;
    const ins=await db().query(`INSERT INTO community_contract_trades(watch_id,tx_hash,log_index,side,trader,token_amount,quote_amount,quote_symbol,block_number) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,[w.id,l.transactionHash,parseInt(l.logIndex,16),side,trader,tokenAmount,quoteAmount,quoteMeta.symbol,parseInt(l.blockNumber,16)]);
    if(!ins.rowCount)continue;
    const tradeUrl=`${EXPLORER[w.network]}/tx/${l.transactionHash}`;
    const text=`${side==="BUY"?"🟢":"🔴"} <b>TOKEN ${side}</b> · ${esc(NET_NAME[w.network] || w.network)}\n<b>${esc(w.token_name||w.token_symbol||"Token")}</b> (${esc(w.token_symbol||"TOKEN")})\n\nToken amount: <b>${fmt(tokenAmount)}</b>\nQuote amount: <b>${fmt(quoteAmount)} ${esc(quoteMeta.symbol)}</b>\nTrader: <code>${esc(short(trader))}</code>\nContract: <code>${esc(w.token_address)}</code>\nPair: <code>${esc(short(w.pair_address))}</code>\n<a href="${tradeUrl}">View transaction</a>\n<i>On-chain DEX swap event · USD value not supplied by this RPC parser</i>`;
    const community=(await db().query(`SELECT c.chat_id,c.status,c.can_post FROM communities c WHERE c.id=$1`,[w.community_id])).rows[0];
    if(community?.status==="active"&&community.can_post&&process.env.TELEGRAM_BOT_TOKEN){
      try {
        const r=await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:community.chat_id,text,parse_mode:"HTML",disable_web_page_preview:true}),signal:AbortSignal.timeout(8000)});
        const result=await r.json().catch(()=>({ok:false}));
        if(r.ok&&result.ok) sent++;
        else { await db().query(`DELETE FROM community_contract_trades WHERE id=$1`,[ins.rows[0].id]); scannedTo=Math.max(from-1,parseInt(l.blockNumber,16)-1); break; }
      } catch { await db().query(`DELETE FROM community_contract_trades WHERE id=$1`,[ins.rows[0].id]); scannedTo=Math.max(from-1,parseInt(l.blockNumber,16)-1); break; }
    } else {
      await db().query(`DELETE FROM community_contract_trades WHERE id=$1`,[ins.rows[0].id]);
      scannedTo=Math.max(from-1,parseInt(l.blockNumber,16)-1); break;
    }
  }
  await db().query(`UPDATE community_contract_watches SET last_block=$2,status='active',last_error=NULL,updated_at=NOW() WHERE id=$1`,[w.id,scannedTo]);
  return {trades:sent};
}

export async function scanCommunityContracts() {
  const started=Date.now();
  const rows=(await db().query(`SELECT w.*,c.status AS community_status,c.can_post FROM community_contract_watches w JOIN communities c ON c.id=w.community_id WHERE w.status IN ('discovering','active') AND c.status='active' AND c.can_post=TRUE ORDER BY w.updated_at ASC LIMIT 30`)).rows;
  let discovered=0,trades=0,errors=0,processed=0;
  for(const w of rows){
    if(Date.now()-started>7000)break;
    try{const r=await processWatch(w);if(r.discovered)discovered++;trades+=r.trades||0;}
    catch(e){errors++;await db().query(`UPDATE community_contract_watches SET last_error=$2,status=CASE WHEN pair_address IS NULL THEN 'discovering' ELSE 'active' END,updated_at=NOW() WHERE id=$1`,[w.id,String(e?.message||"SCAN_FAILED").slice(0,180)]).catch(()=>{});}
    processed++;
  }
  return {watches:processed,remaining:Math.max(0,rows.length-processed),discovered,trades,errors};
}

export const EVM_CONTRACT_NETWORKS=Object.keys(EVM);
