// Auto-detect BEP20 and TRC20 USDT deposits to per-user custodial addresses.
// Only finalized/confirmed transfers are credited. Every chain event is idempotent.
import { db } from './db.js';
import { ensureWalletSchema, withTx, postLedger } from './wallet.js';
import { rpc } from './balances.js';
import { TRANSFER_SIG, tronToHex20 } from './chain.js';

const BSC_USDT='0x55d398326f99059ff775485246999027b3197955'.toLowerCase();
const TRON_USDT='TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const BSC_RPC=process.env.RPC_BSC||'https://bsc-dataseed.binance.org';
const hex=n=>'0x'+BigInt(n).toString(16);
const topicAddress=a=>'0x'+String(a).toLowerCase().replace(/^0x/,'').padStart(64,'0');
function unitsToDecimal(value,decimals){const n=BigInt(value),base=10n**BigInt(decimals),w=n/base,f=(n%base).toString().padStart(decimals,'0').replace(/0+$/,'');return w.toString()+(f?'.'+f:'');}
async function credit({userId,assetId,chain,txHash,logIndex,from,to,amount,blockNumber,confirmations}){
  return withTx(async c=>{
    const ins=await c.query(`INSERT INTO deposits(user_id,asset_id,chain,tx_hash,log_index,from_address,to_address,amount,block_number,confirmations,status,credited_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9,$10,'credited',NOW()) ON CONFLICT(chain,tx_hash,log_index) DO NOTHING RETURNING id`,[userId,assetId,chain,txHash,logIndex,from,to,amount,blockNumber,confirmations]);
    if(!ins.rowCount) return false;
    await postLedger(c,{userId,assetId,kind:'deposit',deltaAvailable:amount,refType:'deposit',refId:chain+':'+txHash+':'+logIndex,note:'Confirmed '+chain+' USDT deposit'});
    return true;
  });
}

export async function scanWalletBep20({maxBlocks=2500,addressBatch=40}={}){
  await ensureWalletSchema();
  const [latestHex,addrRows,asset] = await Promise.all([
    rpc(BSC_RPC,'eth_blockNumber',[]),
    db().query(`SELECT user_id,address FROM wallet_addresses WHERE network='evm' ORDER BY user_id`),
    db().query(`SELECT id,required_confirmations,min_deposit FROM wallet_assets WHERE code='usdt-bsc'`)
  ]);
  if(!asset.rowCount||!addrRows.rowCount) return {scanned:0,credited:0};
  const latest=Number(BigInt(latestHex));
  const safe=latest-Number(asset.rows[0].required_confirmations||15)+1;
  if(safe<=0) return {scanned:0,credited:0};
  const cur=await db().query(`SELECT last_block FROM chain_cursors WHERE chain='bsc-wallet-usdt'`);
  const from=Math.max(0,cur.rowCount?Number(cur.rows[0].last_block)+1:latest-maxBlocks);
  const start=from;
  const end=Math.min(safe,start+maxBlocks-1);
  if(start>end) return {scanned:0,credited:0};
  const byAddress=new Map(addrRows.rows.map(x=>[String(x.address).toLowerCase(),Number(x.user_id)]));
  const addresses=[...byAddress.keys()]; let scanned=0,credited=0;
  for(let off=0;off<addresses.length;off+=addressBatch){
    const group=addresses.slice(off,off+addressBatch);
    const topics=group.map(topicAddress);
    const logs=await rpc(BSC_RPC,'eth_getLogs',[{address:BSC_USDT,fromBlock:hex(start),toBlock:hex(end),topics:['0x'+TRANSFER_SIG,null,topics]}]);
    for(const l of logs||[]){
      scanned++;
      if(!l.topics||l.topics.length!==3) continue;
      const to='0x'+l.topics[2].slice(-40).toLowerCase();
      const userId=byAddress.get(to); if(!userId) continue;
      const amount=unitsToDecimal(BigInt(l.data),18); if(Number(amount)<Number(asset.rows[0].min_deposit||0)) continue;
      const n=await credit({userId,assetId:asset.rows[0].id,chain:'bsc',txHash:l.transactionHash,logIndex:Number(BigInt(l.logIndex)),from:'0x'+l.topics[1].slice(-40),to,amount,blockNumber:Number(BigInt(l.blockNumber)),confirmations:latest-Number(BigInt(l.blockNumber))+1});
      if(n) credited++;
    }
  }
  await db().query(`INSERT INTO chain_cursors(chain,last_block,updated_at) VALUES('bsc-wallet-usdt',$1,NOW()) ON CONFLICT(chain) DO UPDATE SET last_block=GREATEST(chain_cursors.last_block,EXCLUDED.last_block),updated_at=NOW()`,[end]);
  return {scanned,credited,fromBlock:start,toBlock:end,backlog:end<safe};
}

export async function scanWalletTrc20({addressLimit=30}={}){
  await ensureWalletSchema();
  const [cursor,asset]=await Promise.all([
    db().query(`SELECT last_block FROM chain_cursors WHERE chain='tron-wallet-usdt'`),
    db().query(`SELECT id,min_deposit FROM wallet_assets WHERE code='usdt-tron'`)
  ]);
  const after=cursor.rowCount?Number(cursor.rows[0].last_block):0;
  let addrRows=await db().query(`SELECT user_id,address FROM wallet_addresses WHERE network='tron' AND user_id>$1 ORDER BY user_id LIMIT $2`,[after,addressLimit]);
  if(!addrRows.rowCount) addrRows=await db().query(`SELECT user_id,address FROM wallet_addresses WHERE network='tron' ORDER BY user_id LIMIT $1`,[addressLimit]);
  if(!asset.rowCount||!addrRows.rowCount) return {scanned:0,credited:0};
  const headers={'Content-Type':'application/json'}; if(process.env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY']=process.env.TRONGRID_API_KEY;
  let scanned=0,credited=0;
  for(const row of addrRows.rows){
    const url='https://api.trongrid.io/v1/accounts/'+encodeURIComponent(row.address)+'/transactions/trc20?only_to=true&contract_address='+TRON_USDT+'&limit=50&order_by=block_timestamp,desc';
    const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),8000);
    let payload; try{const r=await fetch(url,{headers,signal:ctl.signal});if(!r.ok)continue;payload=await r.json();}finally{clearTimeout(timer);}
    for(const t of payload.data||[]){
      scanned++;
      if(String(t.token_info?.address||'')!==TRON_USDT||String(t.to||'')!==String(row.address)) continue;
      const amount=unitsToDecimal(BigInt(t.value||0),Number(t.token_info?.decimals||6));
      if(Number(amount)<Number(asset.rows[0].min_deposit||0)) continue;
      // The Solidity endpoint only returns irreversible transaction info.
      const ctl2=new AbortController(),timer2=setTimeout(()=>ctl2.abort(),8000); let info;
      try{const r=await fetch('https://api.trongrid.io/walletsolidity/gettransactioninfobyid',{method:'POST',headers,body:JSON.stringify({value:t.transaction_id}),signal:ctl2.signal});if(!r.ok)continue;info=await r.json();}finally{clearTimeout(timer2);}
      if(!info?.id||info.receipt?.result!=='SUCCESS') continue;
      const n=await credit({userId:Number(row.user_id),assetId:asset.rows[0].id,chain:'tron',txHash:t.transaction_id,logIndex:Number(t.event_index||0),from:t.from,to:t.to,amount,blockNumber:Number(info.blockNumber||0),confirmations:19});
      if(n) credited++;
    }
  }
  if(addrRows.rowCount){const last=Math.max(...addrRows.rows.map(x=>Number(x.user_id)));await db().query(`INSERT INTO chain_cursors(chain,last_block,updated_at) VALUES('tron-wallet-usdt',$1,NOW()) ON CONFLICT(chain) DO UPDATE SET last_block=EXCLUDED.last_block,updated_at=NOW()`,[last]);}
  return {scanned,credited,addresses:addrRows.rowCount};
}

export async function cronWalletDeposits(req,res,{authorized,send}){
  if(!authorized(req)) return send(res,401,{ok:false,error:'UNAUTHORIZED'});
  try{
    const [bsc,tron]=await Promise.allSettled([scanWalletBep20(),scanWalletTrc20()]);
    return send(res,200,{ok:true,bsc:bsc.status==='fulfilled'?bsc.value:{error:String(bsc.reason?.message||'SCAN_FAILED')},tron:tron.status==='fulfilled'?tron.value:{error:String(tron.reason?.message||'SCAN_FAILED')}});
  }catch(e){console.error('WALLET_DEPOSIT_CRON',e?.message);return send(res,500,{ok:false,error:'WALLET_DEPOSIT_SCAN_FAILED'});}
}
