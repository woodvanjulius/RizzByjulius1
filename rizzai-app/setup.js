// Run once: node setup.js  -> creates .env (random JWT secret + your admin login).
const fs=require('fs'),c=require('crypto');
if(fs.existsSync('.env')){console.log('.env already exists. Delete it first to regenerate.');process.exit(0)}
fs.writeFileSync('.env',`ANTHROPIC_API_KEY=
MODEL=claude-sonnet-5-5
JWT_SECRET=${c.randomBytes(32).toString('hex')}
ADMIN_PHONE=0741829090
ADMIN_USERNAME="woodvan Julius"
ADMIN_PASSWORD=Trazellababy2
ADMIN_CODE=LIFE
PAY_NUMBER=0741829090
WHATSAPP_NUMBER=256741829090
# Optional: in-app mobile money prompts via Flutterwave. Leave blank to use manual payments only.
FLW_SECRET_KEY=
# Optional: SMS codes via Africa's Talking (sign-up verification, password reset, expiry reminders). Leave blank to turn off.
AT_USERNAME=
AT_API_KEY=
REFERRAL_BONUS=5
NTFY_TOPIC=rizzbyjulius-${c.randomBytes(8).toString('hex')}
PRICE_UGX=3000
PLAN_DAYS=7
FREE_USES=10
NODE_ENV=production
PORT=3000
`,{mode:0o600});
console.log('\n.env created. Add your ANTHROPIC_API_KEY, then run: npm start\nAdmin login: phone 0741829090, username "woodvan Julius" (case does not matter), password from .env.\nFor phone alerts on new payments: install the free ntfy app and subscribe to the NTFY_TOPIC value in .env.\nChange ADMIN_PASSWORD in .env to something private before going live.\n');
