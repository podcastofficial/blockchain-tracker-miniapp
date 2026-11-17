// User withdrawals and admin settlement for the custodial wallet.
// Withdrawals are held in the ledger until an admin records the broadcast transaction.
import { db } from './db.js';
import { send, methodNotAllowed } from './http.js';
import { readSession } from './session.js';
import { rateLimited } from './ratelimit.js';
import { withTx, postLedger, ensureWallet, ensureWalletSchema } from './wallet.js';
import { validAddr } from './balances.js';

const clean = v => String(v ?? '').trim();
const amountPattern = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,18})?$/;
function decimalAdd(a,b,scale=18){const f=10n**BigInt(scale);const to=v=>{const [w,d='']=String(v).split('.');return BigInt(w)*f+BigInt((d+'0'.repeat(scale)).slice(0,scale));};const n=to(a)+to(b);const sign=n<0n?'-':'';const x=n<0n?-n:n;const whole=x/f,frac=(x%f).toString().padStart(scale,'0').replace(/0+$/,'');return sign+whole.toString()+(frac?'.'+frac:'');}

export async function walletWithdrawalsApi(req, res, path) {
  const s = readSession(req);
  if (!s) return send(res, 401, { ok:false, error:'AUTH_REQUIRED' });
  if (rateLimited(req, res, 'wallet-withdraw', s.id, 10)) return;
  try {
    await ensureWallet(s.id);
    if (path === '/api/wallet/deposits') {
      if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
      const r = await db().query(`SELECT d.id,d.chain,d.tx_hash,d.from_address,d.to_address,d.amount::text,d.confirmations,d.status,d.detected_at,d.credited_at,a.code AS asset,a.symbol FROM deposits d JOIN wallet_assets a ON a.id=d.asset_id WHERE d.user_id=$1 ORDER BY d.id DESC LIMIT 100`, [s.id]);
      return send(res, 200, {ok:true, deposits:r.rows});
    }
    if (path === '/api/wallet/withdrawals') {
      if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
      const r = await db().query(`SELECT w.id,w.chain,w.to_address,w.amount::text,w.fee::text,w.status,w.tx_hash,w.error,w.requested_at,w.reviewed_at,w.sent_at,a.code AS asset,a.symbol FROM withdrawals w JOIN wallet_assets a ON a.id=w.asset_id WHERE w.user_id=$1 ORDER BY w.id DESC LIMIT 100`, [s.id]);
      return send(res, 200, {ok:true, withdrawals:r.rows});
    }
    if (path === '/api/wallet/withdraw') {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      const code = clean(req.body?.asset).toLowerCase();
      const address = clean(req.body?.address);
      const amount = clean(req.body?.amount);
      if (!amountPattern.test(amount) || Number(amount) <= 0 || !code || address.length > 128) return send(res,400,{ok:false,error:'INVALID_REQUEST'});
      const asset = await db().query(`SELECT id,chain,network,decimals,min_withdraw,withdraw_fee,withdraw_enabled FROM wallet_assets WHERE code=$1`,[code]);
      if (!asset.rowCount) return send(res,404,{ok:false,error:'ASSET_NOT_FOUND'});
      const a = asset.rows[0];
      const fraction = (amount.split('.')[1] || '').length;
      if (fraction > Number(a.decimals)) return send(res,400,{ok:false,error:'TOO_MANY_DECIMALS',decimals:Number(a.decimals)});
      if (!a.withdraw_enabled) return send(res,400,{ok:false,error:'WITHDRAW_DISABLED'});
      const net = a.network === 'evm' ? a.chain : a.network;
      if (!validAddr(net,address)) return send(res,400,{ok:false,error:'INVALID_ADDRESS'});
      if (Number(amount) < Number(a.min_withdraw)) return send(res,400,{ok:false,error:'BELOW_MIN_WITHDRAW',minimum:a.min_withdraw});
      const fee = String(a.withdraw_fee);
      const result = await withTx(async c => {
        const row = await c.query(`INSERT INTO withdrawals(user_id,asset_id,chain,to_address,amount,fee,status) VALUES($1,$2,$3,$4,$5::numeric,$6::numeric,'pending') RETURNING id`,[s.id,a.id,a.chain,address,amount,fee]);
        const total = decimalAdd(amount,fee,Math.min(18,Number(a.decimals)));
        await postLedger(c,{userId:s.id,assetId:a.id,kind:'withdraw_lock',deltaAvailable:'-'+total,deltaLocked:total,refType:'withdrawal',refId:row.rows[0].id,note:'Withdrawal request locked'});
        return row.rows[0].id;
      });
      return send(res,201,{ok:true,withdrawalId:Number(result),status:'pending',fee});
    }
    return send(res,404,{ok:false,error:'API_ROUTE_NOT_FOUND'});
  } catch(e) {
    const msg = String(e?.message || '');
    if (msg === 'INSUFFICIENT_BALANCE') return send(res,400,{ok:false,error:'INSUFFICIENT_BALANCE'});
    console.error('WALLET_WITHDRAW_ERROR',path,msg);
    return send(res,500,{ok:false,error:'WALLET_OPERATION_FAILED'});
  }
}

export async function adminWalletApi(req,res,path) {
  const s=readSession(req);
  if(!s) return send(res,401,{ok:false,error:'AUTH_REQUIRED'});
  const admins=String(process.env.ADMIN_TELEGRAM_IDS||'').split(',').map(x=>x.trim()).filter(Boolean);
  if(!admins.includes(String(s.telegram_user_id))) return send(res,403,{ok:false,error:'FORBIDDEN'});
  try {
    await ensureWalletSchema();
    if(path==='/api/admin/wallet/withdrawals') {
      if(req.method!=='GET') return methodNotAllowed(res,['GET']);
      const status=clean(new URL(req.url,'https://x.invalid').searchParams.get('status'));
      const r=await db().query(`SELECT w.id,w.user_id,u.telegram_user_id,u.username,w.chain,w.to_address,w.amount::text,w.fee::text,w.status,w.tx_hash,w.error,w.requested_at,a.code AS asset,a.symbol FROM withdrawals w JOIN users u ON u.id=w.user_id JOIN wallet_assets a ON a.id=w.asset_id WHERE ($1='' OR w.status=$1) ORDER BY w.id DESC LIMIT 100`,[status]);
      return send(res,200,{ok:true,withdrawals:r.rows});
    }
    if(path==='/api/admin/wallet/withdrawal') {
      if(req.method!=='POST') return methodNotAllowed(res,['POST']);
      const id=Number(req.body?.id), action=clean(req.body?.action), txHash=clean(req.body?.txHash);
      if(!Number.isSafeInteger(id)||id<1||!['approve','reject','sent','fail'].includes(action)) return send(res,400,{ok:false,error:'INVALID_REQUEST'});
      const result=await withTx(async c=>{
        const q=await c.query(`SELECT w.*,a.id AS aid FROM withdrawals w JOIN wallet_assets a ON a.id=w.asset_id WHERE w.id=$1 FOR UPDATE`,[id]);
        if(!q.rowCount) throw new Error('WITHDRAWAL_NOT_FOUND');
        const w=q.rows[0];
        if(action==='approve') {
          if(w.status!=='pending') throw new Error('INVALID_STATUS');
          await c.query(`UPDATE withdrawals SET status='approved',reviewed_by=$2,reviewed_at=NOW() WHERE id=$1`,[id,String(s.telegram_user_id)]);
        } else if(action==='reject'||action==='fail') {
          if(!['pending','approved','processing'].includes(w.status)) throw new Error('INVALID_STATUS');
          await postLedger(c,{userId:w.user_id,assetId:w.asset_id,kind:'withdraw_release',deltaAvailable:decimalAdd(w.amount,w.fee,18),deltaLocked:'-'+decimalAdd(w.amount,w.fee,18),refType:'withdrawal',refId:id,note:'Withdrawal '+(action==='reject'?'rejected':'failed')+'; funds released'});
          await c.query(`UPDATE withdrawals SET status=$2,error=$3,reviewed_by=$4,reviewed_at=NOW() WHERE id=$1`,[id,action==='reject'?'rejected':'failed',clean(req.body?.reason).slice(0,500)||null,String(s.telegram_user_id)]);
        } else {
          if(w.status!=='approved'&&w.status!=='processing') throw new Error('INVALID_STATUS');
          if(!/^0x[a-fA-F0-9]{64}$/.test(txHash) && !/^[a-fA-F0-9]{64}$/.test(txHash)) throw new Error('INVALID_TX_HASH');
          await postLedger(c,{userId:w.user_id,assetId:w.asset_id,kind:'withdraw_complete',deltaLocked:'-'+decimalAdd(w.amount,w.fee,18),refType:'withdrawal',refId:id,note:'Withdrawal broadcast and completed'});
          await c.query(`UPDATE withdrawals SET status='sent',tx_hash=$2,reviewed_by=$3,reviewed_at=COALESCE(reviewed_at,NOW()),sent_at=NOW(),error=NULL WHERE id=$1`,[id,txHash,String(s.telegram_user_id)]);
        }
        return {id,status:action==='approve'?'approved':action==='reject'?'rejected':action==='fail'?'failed':'sent'};
      });
      return send(res,200,{ok:true,...result});
    }
    return send(res,404,{ok:false,error:'API_ROUTE_NOT_FOUND'});
  } catch(e) {
    const msg=String(e?.message||'');
    const status=msg==='WITHDRAWAL_NOT_FOUND'?404:msg==='INVALID_STATUS'||msg==='INVALID_TX_HASH'?400:500;
    return send(res,status,{ok:false,error:msg||'ADMIN_WALLET_FAILED'});
  }
}
