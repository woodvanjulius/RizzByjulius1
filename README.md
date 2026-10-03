# RizzByJulius (accounts + admin + paywall)

1. `npm install`
2. `node setup.js` - creates `.env` with your admin phone, username and password. Change the password in `.env` before going live.
3. Put your Anthropic API key in `.env` (`ANTHROPIC_API_KEY=`).
4. `npm start`, then host it behind HTTPS (Render, Railway, Fly.io, or a VPS). Keep `rizzai.db` on persistent storage and back it up.

**Admin:** log in on the normal login screen with the admin phone number, username and password (admins must fill in all three). The server detects the admin role and shows an Admin link to `/admin`. Everyone else gets a plain 404 there, and every admin API call is checked on the server.

**Plan:** 10 free uses per account, then 3000 UGX for 7 days (change in `.env`). Counted on the server.

**Payments:** users send money to the Airtel number in `.env` (PAY_NUMBER) and submit the transaction ID. You approve it in the admin panel, which adds 7 days. Check the ID in your Airtel Money history first. For automatic payments, integrate an aggregator that supports Airtel Money Uganda (e.g. Flutterwave, Pesapal) and approve on its webhook.

**Known limits:** someone can open a second account for another 10 free uses (add phone/email verification to reduce this). No password reset yet (admin can create a fresh account or add reset later).

**Accounts:** users sign up with phone number, username and password (phone numbers are unique).

**Admin code:** the home page has an "Admin access" link. Entering `ADMIN_CODE` from `.env` signs you in as admin and opens `/admin`. Admins are never charged and never use free tries. Use a long code: 4 letters is guessable, so attempts are throttled (5 per 15 min per IP, 10 overall).

**Admin team:** from `/admin` the owner (the `.env` admin) can add or remove regular users and other admins (max 5 admins total). Added admins log in with their own phone, username and password. Regular admins can add and remove regular users only. Users can be added without payment, with optional free access days.

**Add member (no password):** in `/admin` an admin types a member's name and the phone number they use on the website. If they already have an account with that number they get free access immediately; if not, they get it automatically when they sign up with it. Leave days empty for no expiry. Admins themselves always use the site free, with no free-trial count. Adding another admin (owner only) still needs a password because admins log in with it.

**Payment number:** admins can change the number users pay to from `/admin` (it shows who changed it last). It overrides `PAY_NUMBER` in `.env`.

**Payment alerts:** a website cannot see your Airtel Money line, so alerts fire when a user submits their transaction ID. (1) The admin panel shows a count, plays a sound and can show a browser notification (tap Enable alerts; it checks every 20 seconds while open). (2) For phone alerts when the panel is closed, install the free **ntfy** app and subscribe to the `NTFY_TOPIC` in `.env` (setup.js creates a random one; if your `.env` already exists, add `NTFY_TOPIC=rizzbyjulius-<random letters>` yourself). Keep the topic name private. Always confirm the money in your Airtel history before approving.

**More admin settings (admins only, in `/admin`):** search users by name or phone, edit the payment number, edit the amount users pay (UGX), edit the WhatsApp contact shown on the home page, and a "Use website" tab to use the app like a normal user.

**In-app mobile money (user enters their PIN on their phone):** set `FLW_SECRET_KEY` in `.env` (a Flutterwave account with Uganda mobile money enabled). The user enters their Airtel or MTN number, gets the PIN prompt on their phone, approves it there, and the app verifies the payment with Flutterwave and unlocks access automatically. The app never sees or stores the PIN. Test in Flutterwave's test mode first. Money settles to your Flutterwave account and is paid out to the wallet/bank you set up there (fees apply); it does not land directly on a phone line. Without the key, users see the manual "send to number + transaction ID" option instead.

**New in this version**
- **Forgot password:** with SMS on, users reset it themselves with a code. Admins can also tap "Reset password" on any user in `/admin` (shows a temporary password once). Users can change their password in the app.
- **SMS (Africa's Talking):** set `AT_USERNAME` and `AT_API_KEY` in `.env`. This turns on sign-up code verification (stops endless free accounts), self-service password reset, and an automatic SMS 24 hours before paid access ends. Without it, those features are off. Use username `sandbox` to test. SMS credits cost money.
- **Terms and 18+:** sign-up requires the "I'm 18+ and agree" box; `/terms` is a short plain-language page. Have a lawyer review it before you rely on it.
- **Dashboard:** users, new users, active plans, free uses, UGX collected (total and last 7 days), plus an "Expiring soon" list with a WhatsApp reminder button.
- **Announcements:** post a banner from `/admin`; users can dismiss it.
- **Referrals:** each user has an invite code and link; both get `REFERRAL_BONUS` extra free tries (default 5). A referrer can earn from 10 friends.
- **Languages:** reply language selector (English, Luganda, Swahili). Check Luganda replies before sending; quality can vary.

## Going live (Replit, easiest on a phone)
1. Create a Replit account, choose **Create Repl > Import**, and upload this folder (or the zip).
2. Open the Shell and run `npm install`, then `node setup.js`.
3. Open the `.env` file and: set `ANTHROPIC_API_KEY`, change `ADMIN_PASSWORD` and `ADMIN_CODE` to private values, and (optional) add `FLW_SECRET_KEY`, `AT_USERNAME`, `AT_API_KEY`.
4. Press **Run**. Replit gives you a web link. For a permanent link, use **Deploy** and keep the database file on a persistent disk.
5. Open the link, log in as admin (phone, username, password) or use the Admin access code, and test: sign up a test user, use the 10 tries, try the payment screen.
6. Install the ntfy app and subscribe to your `NTFY_TOPIC` for payment alerts.
Never share the zip or `.env` after you add real keys and passwords.
