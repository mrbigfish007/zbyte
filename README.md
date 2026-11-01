# Zbyte – Full Stack Platform

Real backend + web frontend + admin panel + mobile starter for the Zbyte earning platform (Nigeria only).

## What is included

| Component | Status | Notes |
|-----------|--------|-------|
| Backend API | Working | Pure Node.js, zero extra packages |
| Web app (user) | Working | Register → Pay → Dashboard → Tasks → Withdraw |
| Payment flow | Mock + Paystack-ready | Replace mock with real Paystack keys |
| Admin panel | Working | Stats, users, withdrawals, run monthly fees |
| Database | File-based JSON | Swap lib/db.js for Prisma + Postgres in production |
| Mobile app | Starter | Expo / React Native instructions in /mobile |

## How to run right now

```bash
cd zbyte-full
node server.js
```

Then open:
- Web app: http://localhost:3000
- Admin: http://localhost:3000/admin

Important: The first user that registers becomes the admin automatically.

## Features implemented

- One-time membership payment (Premium / Silver / Gold)
- Task completion (survey / share post / form) → ₦500 to Task Wallet
- Referral system with correct commissions
- Separate Task & Referral wallets
- Withdrawal requests with minima (₦50k task / ₦10k referral)
- Monthly ₦5,000 fee (admin can trigger; production should use a cron)
- Fee-pending restriction on tasks & withdrawals
- Admin dashboard (users, pending withdrawals, mark paid/reject, run fees)

## Turning this into a real live product

1. Database  
   Replace lib/db.js with Prisma + PostgreSQL (or Supabase). The API shape already matches.

2. Real payments  
   - Create a Paystack (or Flutterwave) account  
   - In /api/auth/register call Paystack Initialize Transaction  
   - Handle the webhook at /api/payments/webhook (already structured for /api/payments/confirm)

3. Hosting  
   - Backend: Railway, Render, DigitalOcean, or AWS  
   - Frontend can stay served by the same Node server or move to Vercel  
   - Domain + SSL (Cloudflare recommended)

4. Security upgrades needed before real money  
   - Proper JWT library + httpOnly cookies  
   - Rate limiting  
   - Input validation (zod)  
   - Password hashing with bcrypt (currently simple hash for zero-deps)  
   - HTTPS only  
   - KYC before first withdrawal

5. Mobile apps  
   See /mobile/README.md. Use Expo, point to your live API, then submit to Play Store & App Store.

6. Legal  
   - Business registration in Nigeria  
   - Terms of Service + Privacy Policy (NDPR)  
   - Clear disclosure that task earnings are limited and most income comes from referrals

## API overview

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/register | Create account + start payment |
| POST | /api/auth/login | Login → JWT |
| GET  | /api/auth/me | Current user |
| POST | /api/payments/confirm | Confirm membership payment |
| GET  | /api/dashboard | User dashboard data |
| POST | /api/tasks/complete | Complete a task |
| POST | /api/withdrawals | Request withdrawal |
| GET  | /api/admin/stats | Admin stats |
| GET  | /api/admin/users | List users |
| GET  | /api/admin/withdrawals | List withdrawals |
| PATCH| /api/admin/withdrawals/:id | Approve / reject |
| POST | /api/admin/run-monthly-fees | Charge monthly fees |

## Project structure

```
zbyte-full/
├── server.js          # Full backend
├── lib/db.js          # Database layer (swap for Prisma later)
├── public/            # User-facing web app
├── admin/             # Admin panel
├── mobile/            # Mobile app notes
└── data/              # JSON database (created at runtime)
```

This is a solid, runnable foundation. The remaining work is production hardening, real payment keys, hosting, and the mobile client.
