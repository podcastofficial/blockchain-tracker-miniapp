/* Phantom deeplink bridge for Telegram Mini App. */
(function(){
  "use strict";
  const STORE="mbt_phantom_pending_v1", SESSION="mbt_phantom_session_v1";
  const b58chars="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function b58encode(bytes){
    let zeros=0;while(zeros<bytes.length&&bytes[zeros]===0)zeros++;
    let digits=[0];
    for(let i=zeros;i<bytes.length;i++){let carry=bytes[i];for(let j=0;j<digits.length;j++){carry+=digits[j]<<8;digits[j]=carry%58;carry=Math.floor(carry/58)}while(carry){digits.push(carry%58);carry=Math.floor(carry/58)}}
    let out="1".repeat(zeros);for(let i=digits.length-1;i>=0;i--)out+=b58chars[digits[i]];
    return out;
  }
  function b58decode(str){
    if(typeof str!=="string"||!str.length)throw Error("Invalid Phantom response");
    let bytes=[0];
    for(const ch of str){const val=b58chars.indexOf(ch);if(val<0)throw Error("Invalid base58 data");let carry=val;for(let j=0;j<bytes.length;j++){carry+=bytes[j]*58;bytes[j]=carry&255;carry>>=8}while(carry){bytes.push(carry&255);carry>>=8}}
    let zeros=0;while(zeros<str.length&&str[zeros]==="1")zeros++;
    const out=new Uint8Array(zeros+bytes.length);for(let i=0;i<bytes.length;i++)out[out.length-1-i]=bytes[i];return out;
  }
  const bytes=n=>{const a=new Uint8Array(n);crypto.getRandomValues(a);return a};
  const toB64=a=>btoa(String.fromCharCode(...a));
  const fromB64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
  const safeJson=s=>{try{return JSON.parse(s)}catch{throw Error("Could not read Phantom response")}};
  // Use native UTF-8 APIs; TweetNaCl core does not include nacl.util.
  const utf8Encode=s=>new TextEncoder().encode(String(s));
  const utf8Decode=b=>new TextDecoder("utf-8",{fatal:true}).decode(b);
  const save=(x)=>localStorage.setItem(STORE,JSON.stringify(x));
  const load=()=>{try{return JSON.parse(localStorage.getItem(STORE)||"null")}catch{return null}};
  let connected=null;
  function mode(){return (window.Telegram&&Telegram.WebApp&&Telegram.WebApp.initData)?"deeplink":"deeplink"}
  function wallet(){return connected||(()=>{try{return localStorage.getItem("mbt_phantom_wallet")||null}catch{return null}})()}
  function disconnect(){connected=null;try{localStorage.removeItem("mbt_phantom_wallet");localStorage.removeItem(SESSION)}catch{}}
  async function relay(sid){
    const r=await fetch("/api/phantom/relay?sid="+encodeURIComponent(sid),{credentials:"include"});
    const j=await r.json();return j;
  }
  async function poll(sid,timeout){
    const until=Date.now()+(timeout||90000);
    while(Date.now()<until){const j=await relay(sid);if(j.ready)return j.result;await new Promise(r=>setTimeout(r,1200))}
    throw Error("Phantom response timed out. Please try connecting again.");
  }
  function callbackUrl(sid,kind){
    const u=new URL("/phantom-return.html",location.origin);
    u.searchParams.set("sid",sid);u.searchParams.set("k",kind);
    u.searchParams.set("src",window.Telegram&&Telegram.WebApp&&Telegram.WebApp.initData?"tg":"web");
    u.searchParams.set("back",location.pathname+location.search);
    return u.toString();
  }
  function deeplink(url){
    // Never navigate Telegram's embedded WebView directly to a wallet deep link.
    // Phantom's HTTPS universal link is opened externally; this avoids ERR_UNKNOWN_URL_SCHEME.
    if(!/^https:\/\/phantom\.app\/ul\/v1\//i.test(url)) throw Error("Invalid Phantom wallet link");
    const tg=window.Telegram&&window.Telegram.WebApp;
    if(tg&&typeof tg.openLink==="function"){
      tg.openLink(url);
      return;
    }
    const w=window.open(url,"_blank","noopener,noreferrer");
    if(!w) throw Error("Could not open Phantom. Please open this Mini App in Telegram and try again.");
  }
  async function start(kind, payload, ctx){
    if(!window.nacl||!nacl.box)throw Error("Secure wallet bridge did not load. Reload the page.");
    const kp=nacl.box.keyPair(), nonce=bytes(24), sid=Array.from(bytes(16),x=>x.toString(16).padStart(2,"0")).join("");
    const appUrl=location.origin;
    const redirect=callbackUrl(sid,kind);
    save({sid,kind,secret:toB64(kp.secretKey),publicKey:toB64(kp.publicKey),nonce:toB64(nonce),created:Date.now(),ctx:ctx||null});
    if(kind==="connect"){
      const u=new URL("https://phantom.app/ul/v1/connect");
      u.searchParams.set("app_url",appUrl);u.searchParams.set("dapp_encryption_public_key",b58encode(kp.publicKey));
      u.searchParams.set("nonce",b58encode(nonce));u.searchParams.set("redirect_link",redirect);
      deeplink(u.toString());
    }else{
      const session=localStorage.getItem(SESSION);if(!session)throw Error("Connect your Phantom wallet first.");
      const shared=window.__mbtPhantomShared;
      if(!shared)throw Error("Reconnect your Phantom wallet to continue.");
      const msg=utf8Encode(JSON.stringify(Object.assign({},payload,{session})));
      const encrypted=nacl.box.after(msg,nonce,shared);
      const u=new URL("https://phantom.app/ul/v1/signAndSendTransaction");
      u.searchParams.set("dapp_encryption_public_key",b58encode(kp.publicKey));
      u.searchParams.set("nonce",b58encode(nonce));u.searchParams.set("redirect_link",redirect);
      u.searchParams.set("payload",toB64(encrypted));
      deeplink(u.toString());
    }
    return sid;
  }
  function decryptResult(p,j){
    const peer=b58decode(j.phantom_encryption_public_key||"");
    const nonce=b58decode(j.nonce||"");
    const data=b58decode(j.data||"");
    const shared=nacl.box.before(peer,fromB64(p.secret));
    const plain=nacl.box.open.after(data,nonce,shared);
    if(!plain)throw Error("Could not decrypt Phantom response");
    return {result:safeJson(utf8Decode(plain)),shared};
  }
  async function finishConnect(p,j){
    if(j.errorCode||j.errorMessage)throw Error(j.errorMessage||"Phantom connection cancelled");
    const d=decryptResult(p,j),result=d.result;
    const pub=result.public_key;
    if(!pub)throw Error("Phantom did not return a wallet address");
    connected=pub;
    localStorage.setItem("mbt_phantom_wallet",connected);
    localStorage.setItem(SESSION,result.session||"");
    window.__mbtPhantomShared=d.shared;
    localStorage.removeItem(STORE);
    return connected;
  }
  async function connect(){
    if(wallet())return wallet();
    const sid=await start("connect");
    const j=await poll(sid,120000);
    const p=load();
    if(!p||p.sid!==sid)throw Error("Phantom session expired. Please connect again.");
    return finishConnect(p,j);
  }
  async function signAndSend(txBase64,ctx){
    if(!wallet())await connect();
    const web3=window.solanaWeb3;if(!web3)throw Error("Solana transaction library did not load.");
    const raw=Uint8Array.from(atob(txBase64),c=>c.charCodeAt(0));
    let tx;try{tx=web3.VersionedTransaction.deserialize(raw)}catch{tx=web3.Transaction.from(raw)}
    const transaction=b58encode(tx.serialize({requireAllSignatures:false,verifySignatures:false}));
    const sid=await start("sign",{transaction,sendOptions:{skipPreflight:false,preflightCommitment:"confirmed"}},ctx);
    const j=await poll(sid,120000);if(j.errorCode||j.errorMessage)throw Error(j.errorMessage||"Phantom request cancelled");
    const p=load();if(!p)throw Error("Phantom session expired");
    const d=decryptResult(p,j);localStorage.removeItem(STORE);
    if(!d.result.signature)throw Error("Phantom did not return a transaction signature");
    return d.result.signature;
  }
  async function resume(callback){
    const p=load();if(!p||Date.now()-p.created>15*60*1000)return;
    try{
      const j=await poll(p.sid,120000);
      if(j.errorCode||j.errorMessage){localStorage.removeItem(STORE);callback({error:j.errorMessage||"Phantom request cancelled",kind:p.kind});return}
      if(p.kind==="connect"){
        const w=await finishConnect(p,j);
        callback({kind:"connect",wallet:w});
      }else{
        const d=decryptResult(p,j),result=d.result;
        localStorage.removeItem(STORE);
        if(!result.signature)throw Error("Phantom did not return a transaction signature");
        callback({kind:"sign",signature:result.signature,ctx:p.ctx||{}});
      }
    }catch(e){localStorage.removeItem(STORE);callback({error:e.message||"Phantom connection failed",kind:p.kind})}
  }
  window.PhantomLink={mode,wallet,disconnect,connect,signAndSend,resume};
})();
