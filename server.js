require('dotenv').config();
const express=require('express'),path=require('path'),crypto=require('crypto');
const Database=require('better-sqlite3'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken');
const cookieParser=require('cookie-parser'),rateLimit=require('express-rate-limit');
const Anthropic=require('@anthropic-ai/sdk');
const {SYSTEM,SCHEMAS}=require('./prompts');
const E=process.env;
const FREE=+E.FREE_USES||10,PRICE0=+E.PRICE_UGX||3000,DAYS=+E.PLAN_DAYS||7,PAY=E.PAY_NUMBER||'',DAY=864e5;
const SECRET=E.JWT_SECRET;
if(!SECRET||!E.ADMIN_USERNAME||!E.ADMIN_PASSWORD||!E.ADMIN_PHONE||!E.ANTHROPIC_API_KEY){console.error('Missing config. Run "node setup.js" and set ANTHROPIC_API_KEY in .env');process.exit(1)}
const client=new Anthropic({apiKey:E.ANTHROPIC_API_KEY}),MODEL=E.MODEL||'claude-sonnet-5-5';
const db=new Database(E.DB_PATH||'rizzai.db');
db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT UNIQUE NOT NULL,hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user',free_used INTEGER NOT NULL DEFAULT 0,sub_until INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,txn TEXT UNIQUE NOT NULL,amount INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL);`);
const norm=p=>{p=String(p||'').replace(/[\s-]/g,'');if(p.startsWith('+256'))p='0'+p.slice(4);else if(p.startsWith('256'))p='0'+p.slice(3);return p};
try{db.exec('ALTER TABLE users ADD COLUMN phone TEXT')}catch(e){}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS u_phone ON users(phone)');
for(const c of ['ref_code TEXT','referred_by INTEGER','bonus INTEGER NOT NULL DEFAULT 0','agreed_at INTEGER','reminded_for INTEGER NOT NULL DEFAULT 0']){try{db.exec('ALTER TABLE users ADD COLUMN '+c)}catch(e){}}
try{db.exec('CREATE UNIQUE INDEX IF NOT EXISTS u_ref ON users(ref_code)')}catch(e){}
db.exec('CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT)');
db.exec('CREATE TABLE IF NOT EXISTS members(phone TEXT PRIMARY KEY,name TEXT,days INTEGER NOT NULL,created_at INTEGER NOT NULL)');
// The admin account exists only because of the secret credentials in .env. Role is stored server-side.
const AU=E.ADMIN_USERNAME.trim().toLowerCase(),AP=norm(E.ADMIN_PHONE),AH=bcrypt.hashSync(E.ADMIN_PASSWORD,12);
const ex=db.prepare('SELECT id FROM users WHERE username=?').get(AU);
if(ex)db.prepare("UPDATE users SET hash=?,role='admin',phone=? WHERE id=?").run(AH,AP,ex.id);
else db.prepare("INSERT INTO users(username,phone,hash,role,created_at) VALUES(?,?,?,'admin',?)").run(AU,AP,AH,Date.now());

const app=express();app.set('trust proxy',1);
app.use(express.json({limit:'8mb'}));app.use(cookieParser());
app.use((q,s,n)=>{s.set({'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'"});n()});
const authLimit=rateLimit({windowMs:15*60*1000,max:20,standardHeaders:true,legacyHeaders:false});
const genLimit=rateLimit({windowMs:60*1000,max:8,standardHeaders:true,legacyHeaders:false});
const ck=u=>({httpOnly:true,sameSite:'strict',secure:E.NODE_ENV==='production',maxAge:(u&&u.role==='admin'?7:30)*DAY}); // users stay signed in 30 days, admins 7
const sign=u=>jwt.sign({id:u.id},SECRET,{expiresIn:u.role==='admin'?'7d':'30d'});
const REFB=+E.REFERRAL_BONUS||5,RC='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function refOf(u){if(u.ref_code)return u.ref_code;for(let i=0;i<10;i++){const c=Array.from({length:6},()=>RC[crypto.randomInt(RC.length)]).join('');try{db.prepare('UPDATE users SET ref_code=? WHERE id=?').run(c,u.id);return c}catch(e){}}return ''}
const statsNow=()=>{const n=Date.now(),w=n-7*864e5,g=(sql,...a)=>db.prepare(sql).get(...a).c;return{
 users:g("SELECT COUNT(*) c FROM users WHERE role='user'"),
 newWeek:g("SELECT COUNT(*) c FROM users WHERE role='user' AND created_at>?",w),
 active:g("SELECT COUNT(*) c FROM users WHERE role='user' AND sub_until>?",n),
 freeUsed:g("SELECT COALESCE(SUM(free_used),0) c FROM users WHERE role='user'"),
 paidTotal:g("SELECT COALESCE(SUM(amount),0) c FROM payments WHERE status IN ('approved','paid')"),
 paidWeek:g("SELECT COALESCE(SUM(amount),0) c FROM payments WHERE status IN ('approved','paid') AND created_at>?",w),
 paidCount:g("SELECT COUNT(*) c FROM payments WHERE status IN ('approved','paid')"),
 pending:g("SELECT COUNT(*) c FROM payments WHERE status='pending'")}};
const getAnn=()=>(db.prepare("SELECT v FROM settings WHERE k='announce'").get()||{}).v||'';
const getPrice=()=>{const r=db.prepare("SELECT v FROM settings WHERE k='price'").get();return r?+r.v:PRICE0}; // amount editable by admins
const getWa=()=>{const r=db.prepare("SELECT v FROM settings WHERE k='wa'").get();return r?r.v:String(E.WHATSAPP_NUMBER||'256741829090').replace(/\D/g,'')};
const getPay=()=>{const r=db.prepare("SELECT v FROM settings WHERE k='pay'").get();return r?r.v:PAY}; // payment number editable by admins
const view=u=>({username:u.username,role:u.role,freeLeft:Math.max(0,FREE+u.bonus-u.free_used),free:FREE+u.bonus,refCode:refOf(u),subUntil:u.sub_until,active:u.sub_until>Date.now(),price:getPrice(),days:DAYS,payNumber:getPay(),auto:!!FLW,phone:u.phone});
const byId=id=>db.prepare('SELECT * FROM users WHERE id=?').get(id);
function auth(q,s,n){try{const u=byId(jwt.verify(q.cookies.t,SECRET).id);if(!u)throw 0;q.user=u;n()}catch(e){s.status(401).json({error:'Please log in.',code:'AUTH'})}}
const adminOnly=(q,s,n)=>q.user.role==='admin'?n():s.status(404).json({error:'Not found'});

// ---- SMS (Africa's Talking). Without AT_USERNAME + AT_API_KEY, SMS is off: sign-up needs no code and password resets are done by an admin. ----
const SMS=!!(E.AT_USERNAME&&E.AT_API_KEY);
async function sendSms(phone,message){
 if(!SMS)return false;
 const host=E.AT_USERNAME==='sandbox'?'api.sandbox.africastalking.com':'api.africastalking.com';
 try{const r=await fetch('https://'+host+'/version1/messaging',{method:'POST',headers:{apiKey:E.AT_API_KEY,Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:E.AT_USERNAME,to:'+256'+phone.slice(1),message})});return r.ok}catch(e){console.error('sms failed:',e.message);return false}
}
db.exec('CREATE TABLE IF NOT EXISTS otps(phone TEXT NOT NULL,purpose TEXT NOT NULL,hash TEXT NOT NULL,expires INTEGER NOT NULL,tries INTEGER NOT NULL DEFAULT 0,sent INTEGER NOT NULL,PRIMARY KEY(phone,purpose))');
const otpHash=c=>crypto.createHmac('sha256',SECRET).update(String(c)).digest('hex');
function otpCheck(phone,purpose,code){
 const o=db.prepare('SELECT * FROM otps WHERE phone=? AND purpose=?').get(phone,purpose);
 if(!o||o.expires<Date.now()||o.tries>=5)return false;
 db.prepare('UPDATE otps SET tries=tries+1 WHERE phone=? AND purpose=?').run(phone,purpose);
 const ok=otpHash(String(code||'').trim())===o.hash;
 if(ok)db.prepare('DELETE FROM otps WHERE phone=? AND purpose=?').run(phone,purpose);
 return ok;
}
const otpLimit=rateLimit({windowMs:10*60*1000,max:5,standardHeaders:true,legacyHeaders:false});
app.post('/api/otp/send',otpLimit,async(q,s)=>{
 if(!SMS)return s.status(404).json({error:'SMS is not enabled.'});
 const ph=norm(q.body.phone),purpose=q.body.purpose==='reset'?'reset':'signup';
 if(!/^0\d{9}$/.test(ph))return s.status(400).json({error:'Enter a valid phone number, e.g. 0701234567.'});
 const prev=db.prepare('SELECT sent FROM otps WHERE phone=? AND purpose=?').get(ph,purpose);
 if(prev&&Date.now()-prev.sent<60000)return s.status(429).json({error:'Wait a minute before asking for another code.'});
 const exists=db.prepare('SELECT 1 FROM users WHERE phone=?').get(ph);
 if(purpose==='signup'&&exists)return s.status(409).json({error:'That phone number is already registered.'});
 if(purpose==='reset'&&!exists)return s.json({ok:true}); // don't reveal which numbers have accounts
 const code=String(crypto.randomInt(100000,1000000));
 db.prepare('INSERT OR REPLACE INTO otps(phone,purpose,hash,expires,tries,sent) VALUES(?,?,?,?,0,?)').run(ph,purpose,otpHash(code),Date.now()+10*60000,Date.now());
 const ok=await sendSms(ph,'RizzByJulius code: '+code+'. It expires in 10 minutes. Never share it.');
 ok?s.json({ok:true}):s.status(502).json({error:"Couldn't send the SMS. Try again."});
});
app.post('/api/password/reset',authLimit,(q,s)=>{
 const ph=norm(q.body.phone),pw=String(q.body.password||'');
 if(pw.length<8||pw.length>100)return s.status(400).json({error:'Password must be at least 8 characters.'});
 if(!SMS||!otpCheck(ph,'reset',q.body.code))return s.status(400).json({error:'Wrong or expired code.'});
 const u=db.prepare('SELECT * FROM users WHERE phone=?').get(ph);
 if(!u||u.role==='admin')return s.status(400).json({error:'Wrong or expired code.'}); // admins are reset by the owner
 db.prepare('UPDATE users SET hash=? WHERE id=?').run(bcrypt.hashSync(pw,12),u.id);
 s.json({ok:true});
});
app.post('/api/change-password',auth,authLimit,(q,s)=>{
 const o=String(q.body.oldPassword||''),n=String(q.body.newPassword||'');
 if(q.user.username===AU)return s.status(400).json({error:'The owner password is set in .env.'});
 if(n.length<8||n.length>100)return s.status(400).json({error:'New password must be at least 8 characters.'});
 if(!bcrypt.compareSync(o,q.user.hash))return s.status(401).json({error:'Current password is wrong.'});
 db.prepare('UPDATE users SET hash=? WHERE id=?').run(bcrypt.hashSync(n,12),q.user.id);
 s.json({ok:true});
});
// Hourly: SMS a reminder to users whose paid access ends within 24 hours (once per expiry date). Only when SMS is on.
setInterval(async()=>{if(!SMS)return;const now=Date.now();for(const u of db.prepare("SELECT * FROM users WHERE role='user' AND sub_until>? AND sub_until<? AND reminded_for<>sub_until").all(now,now+24*3600e3)){db.prepare('UPDATE users SET reminded_for=? WHERE id=?').run(u.sub_until,u.id);await sendSms(u.phone,'RizzByJulius: your access ends within 24 hours. Open the app to renew and keep going.')}},3600e3).unref();
app.post('/api/signup',authLimit,(q,s)=>{
 const un=String(q.body.username||'').trim().toLowerCase(),pw=String(q.body.password||''),ph=norm(q.body.phone);
 if(q.body.agree!==true)return s.status(400).json({error:'Please confirm you are 18+ and accept the Terms.'});
 if(!/^[a-z0-9_]{3,20}$/.test(un))return s.status(400).json({error:'Username: 3-20 letters, numbers or underscore.'});
 if(!/^0\d{9}$/.test(ph))return s.status(400).json({error:'Enter a valid phone number, e.g. 0701234567.'});
 if(pw.length<8||pw.length>100)return s.status(400).json({error:'Password must be at least 8 characters.'});
 if(un===AU||ph===AP||db.prepare('SELECT 1 FROM users WHERE username=? OR phone=?').get(un,ph))return s.status(409).json({error:'That username or phone number is already registered.'});
 if(SMS&&!otpCheck(ph,'signup',q.body.code))return s.status(400).json({error:'Wrong or expired SMS code.'});
 const id=db.prepare("INSERT INTO users(username,phone,hash,role,created_at) VALUES(?,?,?,'user',?)").run(un,ph,bcrypt.hashSync(pw,12),Date.now()).lastInsertRowid;
 db.prepare('UPDATE users SET agreed_at=? WHERE id=?').run(Date.now(),id);
 const rc=String(q.body.ref||'').trim().toUpperCase(); // referral: both get bonus free tries (referrer capped at 10 friends)
 if(rc){const r=db.prepare('SELECT id FROM users WHERE ref_code=?').get(rc);if(r){db.prepare('UPDATE users SET bonus=bonus+?,referred_by=? WHERE id=?').run(REFB,r.id,id);if(db.prepare('SELECT COUNT(*) c FROM users WHERE referred_by=?').get(r.id).c<=10)db.prepare('UPDATE users SET bonus=bonus+? WHERE id=?').run(REFB,r.id)}}
 const mem=db.prepare('SELECT * FROM members WHERE phone=?').get(ph); // pre-added by an admin: free access on sign-up
 if(mem){db.prepare('UPDATE users SET sub_until=? WHERE id=?').run(Date.now()+mem.days*DAY,id);db.prepare('DELETE FROM members WHERE phone=?').run(ph)}
 s.cookie('t',sign({id}),ck()).json({me:view(byId(id))});
});
app.post('/api/login',authLimit,(q,s)=>{
 const un=String(q.body.username||'').trim().toLowerCase(),u=db.prepare('SELECT * FROM users WHERE username=?').get(un),bad=()=>s.status(401).json({error:'Wrong login details.'});
 if(!u||!bcrypt.compareSync(String(q.body.password||''),u.hash))return bad();
 if(u.role==='admin'&&norm(q.body.phone)!==u.phone)return bad(); // admins must also give their phone number
 s.cookie('t',sign(u),ck(u)).json({me:view(u)});
});
// Admin secret-code login. Strictly throttled because a short code is guessable: 5 tries/15 min per IP AND 10 failures/15 min overall.
const CODE=String(E.ADMIN_CODE||'').trim().toUpperCase(),codeIpLimit=rateLimit({windowMs:15*60*1000,max:5,standardHeaders:true,legacyHeaders:false});
let codeFails=[];const sh=x=>crypto.createHash('sha256').update(x).digest();
app.post('/api/admin-code',codeIpLimit,(q,s)=>{
 if(!CODE)return s.status(404).json({error:'Not found'});
 const now=Date.now();codeFails=codeFails.filter(t=>now-t<15*60*1000);
 if(codeFails.length>=10)return s.status(429).json({error:'Too many attempts. Try again later.'});
 const given=String(q.body.code||'').trim().toUpperCase().slice(0,100);
 if(!crypto.timingSafeEqual(sh(given),sh(CODE))){codeFails.push(now);return s.status(401).json({error:'Wrong code.'})}
 const u=db.prepare("SELECT * FROM users WHERE username=? AND role='admin'").get(AU);
 s.cookie('t',sign(u),ck(u)).json({me:view(u)});
});
app.post('/api/logout',(q,s)=>s.clearCookie('t').json({ok:true}));
app.get('/api/me',auth,async(q,s)=>{for(const p of db.prepare("SELECT * FROM payments WHERE user_id=? AND status='processing'").all(q.user.id))await settleOne(p);s.json({me:view(byId(q.user.id))})});

// Phone notification (free, via ntfy.sh) when a user submits a payment. Set NTFY_TOPIC in .env and subscribe to it in the ntfy app.
const NTFY=String(E.NTFY_TOPIC||'').trim();
const notify=(title,msg)=>{if(!NTFY)return;fetch('https://ntfy.sh/'+encodeURIComponent(NTFY),{method:'POST',headers:{Title:title,Priority:'high',Tags:'money_with_wings'},body:msg}).catch(e=>console.error('notify failed:',e.message))};
app.post('/api/pay',auth,(q,s)=>{
 const txn=String(q.body.txn||'').trim().toUpperCase();
 if(!/^[A-Z0-9]{6,30}$/.test(txn))return s.status(400).json({error:'Enter the transaction ID from your Airtel confirmation SMS.'});
 if(db.prepare("SELECT COUNT(*) c FROM payments WHERE user_id=? AND status='pending'").get(q.user.id).c>=3)return s.status(429).json({error:'You already have pending payments. Please wait for approval.'});
 try{db.prepare('INSERT INTO payments(user_id,txn,amount,created_at) VALUES(?,?,?,?)').run(q.user.id,txn,getPrice(),Date.now())}
 catch(e){return s.status(409).json({error:'That transaction ID was already submitted.'})}
 notify('New payment submitted',q.user.username+' ('+(q.user.phone||'no phone')+') sent '+getPrice()+' UGX. TXN '+txn+'. Check Airtel Money, then approve in the admin panel.');
 s.json({message:'Received. Access starts once the admin confirms your payment.'});
});

// ---- In-app mobile money (Flutterwave). The customer approves on their OWN phone with their mobile money PIN; this app never sees the PIN. ----
const FLW=String(E.FLW_SECRET_KEY||'').trim();
const flw=(p,o={})=>fetch('https://api.flutterwave.com/v3'+p,{...o,headers:{Authorization:'Bearer '+FLW,'Content-Type':'application/json'}}).then(r=>r.json());
const payLimit=rateLimit({windowMs:60*1000,max:5,standardHeaders:true,legacyHeaders:false});
async function settleOne(p){
 if(p.status!=='processing')return p.status;
 try{
  const r=await flw('/transactions/verify_by_reference?tx_ref='+encodeURIComponent(p.txn)),d=r&&r.data;
  if(d&&d.tx_ref===p.txn){
   if(d.status==='successful'&&d.currency==='UGX'&&+d.amount>=p.amount){
    const c=db.prepare("UPDATE payments SET status='paid' WHERE id=? AND status='processing'").run(p.id);
    if(c.changes){grant(p.user_id,DAYS);const u=byId(p.user_id);notify('Payment received',(u?u.username:'a user')+' paid '+p.amount+' UGX by mobile money. Access activated.')}
    return 'paid';
   }
   if(d.status==='failed'||d.status==='cancelled'){db.prepare("UPDATE payments SET status='failed' WHERE id=? AND status='processing'").run(p.id);return 'failed'}
  }
 }catch(e){console.error('verify failed:',e.message)}
 if(Date.now()-p.created_at>15*60*1000){db.prepare("UPDATE payments SET status='failed' WHERE id=? AND status='processing'").run(p.id);return 'failed'}
 return 'processing';
}
app.post('/api/pay/start',auth,payLimit,async(q,s)=>{
 if(!FLW)return s.status(404).json({error:'In-app payment is not enabled yet.'});
 const ph=norm(q.body.phone),net=['AIRTEL','MTN'].includes(q.body.network)?q.body.network:null;
 if(!/^0\d{9}$/.test(ph)||!net)return s.status(400).json({error:'Enter a valid mobile money number, e.g. 0741234567.'});
 const u=q.user,amount=getPrice(),ref='RBJ'+u.id+'T'+Date.now()+crypto.randomBytes(3).toString('hex');
 db.prepare("INSERT INTO payments(user_id,txn,amount,status,created_at) VALUES(?,?,?,'processing',?)").run(u.id,ref,amount,Date.now());
 try{
  const r=await flw('/charges?type=mobile_money_uganda',{method:'POST',body:JSON.stringify({tx_ref:ref,amount,currency:'UGX',email:u.username+'@users.rizzbyjulius.app',fullname:u.username,phone_number:'256'+ph.slice(1),network:net})});
  if(r.status!=='success')throw new Error(r.message||'charge rejected');
  s.json({ref,message:'Check your phone and enter your mobile money PIN to approve '+amount+' UGX.'});
 }catch(e){console.error('charge failed:',e.message);db.prepare("UPDATE payments SET status='failed' WHERE txn=?").run(ref);s.status(502).json({error:'Could not start the payment. Check the number and network, or pay manually.'})}
});
app.get('/api/pay/status/:ref',auth,async(q,s)=>{
 const p=db.prepare('SELECT * FROM payments WHERE txn=? AND user_id=?').get(String(q.params.ref),q.user.id);
 if(!p)return s.status(404).json({error:'Not found'});
 s.json({status:await settleOne(p)});
});

const MOODS=['Flirty','Spicy','Casual','Funny','Motivating'];
const TASKS={reply:'Suggest 3 reply options to her latest message.',rate:'The user wrote a draft reply. Score it out of 10, explain, list improvements, and give an improved version. Use anything pasted as her message for context.',opener:'Write 3 openers based on her profile/bio. Reference something specific from it.'};
app.post('/api/generate',auth,genLimit,async(q,s)=>{
 const u=q.user,b=q.body||{},isA=u.role==='admin',sub=u.sub_until>Date.now();
 if(!isA&&!sub&&u.free_used>=FREE+u.bonus)return s.status(402).json({error:`Free trial finished. Pay ${getPrice()} UGX for ${DAYS} days to continue.`,code:'PAYWALL'});
 const mode=TASKS[b.mode]?b.mode:'reply';
 const moods=(Array.isArray(b.moods)?b.moods:[]).filter(m=>MOODS.includes(m)).slice(0,2);if(!moods.length)moods.push('Flirty');
 const text=String(b.text||'').slice(0,4000),ctx=String(b.context||'').slice(0,500);
 const len=['short (under 15 words)','medium (1-2 sentences)','long (2-4 sentences)'][+b.length]||'medium (1-2 sentences)';
 const lang=['English','Luganda','Swahili'].includes(b.lang)?b.lang:'English';
 const m=/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image||''));
 const img=m?{type:'image',source:{type:'base64',media_type:m[1],data:m[2]}}:null;
 if(!text&&!img)return s.status(400).json({error:'Add a screenshot or some text first.'});
 const prompt=`TASK: ${TASKS[mode]}\nMood: ${moods.join(' + ')}\nReply length: ${len}\n${lang!=='English'?'Write the message texts in '+lang+' the way people really text it (natural, light English mixing is fine). Keep notes, signals and tips in English.\n':''}Extra context: ${ctx||'none'}\n${img?'A screenshot is attached.\n':''}${text?'Text input:\n'+text+'\n':''}${b.regen?'Give different options than before. Variation seed '+(Date.now()%1000)+'.\n':''}\nReturn JSON exactly in this shape:\n${SCHEMAS[mode]}`;
 try{
  const r=await client.messages.create({model:MODEL,max_tokens:1200,system:SYSTEM,messages:[{role:'user',content:[...(img?[img]:[]),{type:'text',text:prompt}]}]});
  const data=JSON.parse(r.content.map(c=>c.text||'').join('').replace(/```json|```/g,'').trim());
  if(!isA&&!sub)db.prepare('UPDATE users SET free_used=free_used+1 WHERE id=?').run(u.id); // only charged on success
  s.json({data,me:view(byId(u.id))});
 }catch(e){console.error('generate failed:',e.message);s.status(502).json({error:'The AI had a hiccup. Try again (you were not charged a use).'})}
});

// ---- Admin (server-checked role; everyone else gets a plain 404) ----
app.get('/admin',(q,s)=>{try{const u=byId(jwt.verify(q.cookies.t,SECRET).id);if(u&&u.role==='admin')return s.sendFile(path.join(__dirname,'private','admin.html'))}catch(e){}s.status(404).send('Not found')});
app.get('/api/admin/overview',auth,adminOnly,(q,s)=>s.json({
 users:db.prepare('SELECT id,username,phone,role,free_used,sub_until,created_at FROM users ORDER BY id DESC LIMIT 500').all(),
 payments:db.prepare("SELECT p.id,p.txn,p.amount,p.status,p.created_at,u.username FROM payments p JOIN users u ON u.id=p.user_id ORDER BY (p.status='pending') DESC,p.id DESC LIMIT 200").all(),
 plan:{price:getPrice(),days:DAYS,free:FREE},members:db.prepare('SELECT phone,name,days,created_at FROM members ORDER BY created_at DESC').all(),whatsapp:getWa(),autoPay:!!FLW,payNumber:getPay(),payBy:(db.prepare("SELECT v FROM settings WHERE k='pay_by'").get()||{}).v||'',isOwner:q.user.username===AU,meId:q.user.id,maxAdmins:MAXADMINS,stats:statsNow(),expiring:db.prepare("SELECT username,phone,sub_until FROM users WHERE role='user' AND sub_until>? AND sub_until<? ORDER BY sub_until").all(Date.now(),Date.now()+3*864e5),announcement:getAnn(),sms:SMS}));
const MAXADMINS=5;
const grant=(uid,days)=>{const u=byId(uid);db.prepare('UPDATE users SET sub_until=? WHERE id=?').run(Math.max(Date.now(),u.sub_until)+days*DAY,uid)};
app.post('/api/admin/payments/:id/:act',auth,adminOnly,(q,s)=>{
 const p=db.prepare("SELECT * FROM payments WHERE id=? AND status='pending'").get(+q.params.id);
 if(!p||!['approve','reject'].includes(q.params.act))return s.status(404).json({error:'Not found'});
 db.transaction(()=>{db.prepare('UPDATE payments SET status=? WHERE id=?').run(q.params.act==='approve'?'approved':'rejected',p.id);if(q.params.act==='approve')grant(p.user_id,DAYS)})();
 s.json({ok:true});
});
app.post('/api/admin/users/:id/grant',auth,adminOnly,(q,s)=>{
 const d=Math.min(365,Math.max(1,+q.body.days||0));if(!byId(+q.params.id))return s.status(404).json({error:'Not found'});
 grant(+q.params.id,d);s.json({ok:true});
});

app.post('/api/admin/settings',auth,adminOnly,(q,s)=>{
 const b=q.body||{},set=[];
 if(b.payNumber!==undefined){const p=norm(b.payNumber);if(!/^0\d{9}$/.test(p))return s.status(400).json({error:'Enter a valid payment phone number, e.g. 0741829090.'});set.push(['pay',p])}
 if(b.price!==undefined){const n=Math.round(+b.price);if(!(n>=500&&n<=1000000))return s.status(400).json({error:'Amount must be between 500 and 1,000,000 UGX.'});set.push(['price',String(n)])}
 if(b.whatsapp!==undefined){const w=String(b.whatsapp).replace(/[\s()-]/g,'').replace(/^\+/,'').replace(/^00/,'');if(!/^\d{10,15}$/.test(w))return s.status(400).json({error:'Enter the WhatsApp number with country code, e.g. +256741829090.'});set.push(['wa',w])}
 if(b.announcement!==undefined)set.push(['announce',String(b.announcement).trim().slice(0,200)]);
 if(!set.length)return s.status(400).json({error:'Nothing to update.'});
 const up=db.prepare('INSERT OR REPLACE INTO settings(k,v) VALUES(?,?)'),stamp=q.user.username+' on '+new Date().toISOString().slice(0,16).replace('T',' ')+' UTC';
 db.transaction(()=>{for(const [k,v] of set)up.run(k,v);if(set.some(x=>x[0]==='pay'))up.run('pay_by',stamp)})();
 s.json({ok:true});
});
app.post('/api/admin/users/:id/reset',auth,adminOnly,(q,s)=>{
 const t=byId(+q.params.id);if(!t)return s.status(404).json({error:'Not found'});
 if(t.username===AU)return s.status(400).json({error:'Change the owner password in .env.'});
 if(t.role==='admin'&&q.user.username!==AU)return s.status(403).json({error:'Only the owner can reset an admin password.'});
 const pw=crypto.randomBytes(6).toString('base64url');
 db.prepare('UPDATE users SET hash=? WHERE id=?').run(bcrypt.hashSync(pw,12),t.id);
 s.json({ok:true,password:pw});
});
// Add a member by name + phone only (no password). If they already have an account with that number they get free access now; otherwise they get it automatically when they sign up with it.
app.post('/api/admin/members',auth,adminOnly,(q,s)=>{
 const name=String(q.body.name||'').trim().slice(0,40),ph=norm(q.body.phone),days=Math.min(3650,Math.max(1,+q.body.days||3650));
 if(name.length<2)return s.status(400).json({error:"Enter the member's name."});
 if(!/^0\d{9}$/.test(ph))return s.status(400).json({error:'Enter a valid phone number, e.g. 0701234567.'});
 const u=db.prepare('SELECT * FROM users WHERE phone=?').get(ph);
 if(u){if(u.role==='admin')return s.status(400).json({error:'That number belongs to an admin, who already has free access.'});grant(u.id,days);return s.json({ok:true,message:'Free access given to '+u.username+'.'})}
 db.prepare('INSERT OR REPLACE INTO members(phone,name,days,created_at) VALUES(?,?,?,?)').run(ph,name,days,Date.now());
 s.json({ok:true,message:'Saved. When '+name+' signs up with this number, they get free access automatically.'});
});
app.delete('/api/admin/members/:phone',auth,adminOnly,(q,s)=>{db.prepare('DELETE FROM members WHERE phone=?').run(norm(q.params.phone));s.json({ok:true})});
// Add / remove users. Only the owner (the .env admin) can add or remove other admins. Max 5 admins in total.
// Admins only (with password). Regular members are added by name + phone via /api/admin/members.
app.post('/api/admin/admins',auth,adminOnly,(q,s)=>{
 const b=q.body||{},un=String(b.username||'').trim().toLowerCase(),ph=norm(b.phone),pw=String(b.password||''),role='admin',days=0;
 if(!/^[a-z0-9_]{3,20}$/.test(un))return s.status(400).json({error:'Username: 3-20 letters, numbers or underscore.'});
 if(!/^0\d{9}$/.test(ph))return s.status(400).json({error:'Enter a valid phone number, e.g. 0701234567.'});
 if(pw.length<8||pw.length>100)return s.status(400).json({error:'Password must be at least 8 characters.'});
 if(role==='admin'){
  if(q.user.username!==AU)return s.status(403).json({error:'Only the owner can add admins.'});
  if(db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c>=MAXADMINS)return s.status(400).json({error:'Admin limit reached ('+MAXADMINS+').'});
 }
 if(un===AU||db.prepare('SELECT 1 FROM users WHERE username=? OR phone=?').get(un,ph))return s.status(409).json({error:'That username or phone number is already registered.'});
 db.prepare('INSERT INTO users(username,phone,hash,role,sub_until,created_at) VALUES(?,?,?,?,?,?)').run(un,ph,bcrypt.hashSync(pw,12),role,days?Date.now()+days*DAY:0,Date.now());
 s.json({ok:true});
});
app.delete('/api/admin/users/:id',auth,adminOnly,(q,s)=>{
 const t=byId(+q.params.id);if(!t)return s.status(404).json({error:'Not found'});
 if(t.id===q.user.id||t.username===AU)return s.status(400).json({error:"This account can't be removed."});
 if(t.role==='admin'&&q.user.username!==AU)return s.status(403).json({error:'Only the owner can remove admins.'});
 db.transaction(()=>{db.prepare('DELETE FROM payments WHERE user_id=?').run(t.id);db.prepare('DELETE FROM users WHERE id=?').run(t.id)})();
 s.json({ok:true});
});

app.get('/api/config',(q,s)=>s.json({whatsapp:getWa(),price:getPrice(),days:DAYS,free:FREE,sms:SMS,announcement:getAnn()}));
app.get('/terms',(q,s)=>s.sendFile(path.join(__dirname,'public','terms.html')));
app.use(express.static(path.join(__dirname,'public')));
app.listen(+E.PORT||3000,()=>console.log('RizzByJulius running on port '+(E.PORT||3000)));
