# Zimbabwe Payslip Portal

A React, Express, and PostgreSQL payslip portal with separate payroll-admin and employee areas. Payroll calculations use the shared 2026 USD ZIMRA/NSSA calculator in `backend/src/lib/payroll/zim-paye.ts`.

## Run with Docker Compose

Requirements: Docker Compose and OpenSSL.

1. Create a private local environment file and generate secrets:

   ```bash
   cp .env.example .env
   openssl rand -hex 24
   openssl rand -hex 32
   ```

   Use the outputs for `POSTGRES_PASSWORD` and `JWT_SECRET` in `.env`. Keep `.env` private; it is git-ignored.

2. Build and start the database, API, and web app:

   ```bash
   docker compose up --build -d
   ```

   Compose applies `backend/schema.sql` before starting the API. Open <http://localhost:9000>.

3. On a fresh database, the portal seeds one administrator:

   - Company number: `ADMIN-001`
   - Temporary password: `ChangeMe2026`

   Change this password immediately. The seeded account is created only if no administrator exists. Do not reset a password or expose this initial credential outside your private deployment process.

## Accounts and roles

- Sign in with a company number and password; company numbers are normalized to uppercase.
- Administrators manage people, rates, payroll runs, payslips, and returns at `/admin`.
- Employees can view only their own details and payslips at `/me`. They can request a bank-detail change; paid bank details change only after an administrator accepts it.
- There is no public registration. An administrator creates accounts and sets a temporary password. Users must change temporary passwords before viewing any payroll data.
- Passwords are stored as bcrypt hashes. Sessions are server-tracked, HttpOnly cookies. Sign out invalidates the current session.

## Monthly USD payroll

Add employees on **People** or use the admin-only **Import Excel** page. Excel imports read the first worksheet and require Employee number, Name, Department, Basic salary, Allowances, and Deductions columns. Allowances map to other allowance; imported deductions are included in new and open draft runs. New employee accounts receive a one-time temporary password and must change it at first sign-in. Missing employees are not deleted.

Then open **Run payroll** for a `YYYY-MM` month. Enter overtime, bonus, loan recovery, other deduction, and leave days taken; leave taken cannot exceed the employee's current leave balance. Maintain salary, allowances, and the employee's leave balance on **People**. Statutory values are calculated by `calcLine()` and are read-only in the interface.

Set `EMAIL_API_KEY` and a Resend-verified `EMAIL_FROM` in `.env` to email payslips. Resend requires a sender on a domain you have verified; a personal Gmail address cannot be used as the sender. Add each employee's address on **People**. After an admin confirms the payroll lock, the portal saves the locked run first, then sends each active employee only their own PDF. Missing addresses are skipped, and individual delivery failures are reported without undoing payroll.

The **Rates** screen starts with the 2026 USD tax bands, 4.5% employee/employer NSSA, a USD 700 NSSA ceiling, 3% AIDS levy, 0.5% SDF, and 0% NEC. Review the draft and confirm the month to snapshot calculations, rates, employee identity, bank details, leave taken, and leave balance after. Confirming deducts leave once; unlocking restores each employee's pre-confirmation balance and removes payslips so the draft can be recalculated.

Run totals include wage bill, PAYE and AIDS levy, both sides of NSSA, and net pay to bank. PAYE plus AIDS levy is due to ZIMRA by the 10th of the following month.

> 2026 USD ZIMRA table. Confirm on zimra.co.zw and nssa.org.zw before filing.

The system rounds money values to two decimals. The employee NSSA deduction is subtracted before PAYE by default. NSSA-exempt employees have no employee or employer NSSA contribution.

## CSV payslip import

The existing transactional import remains available for historical payslips. Supply an `imports/` CSV with these headers:

```csv
email,period_start,period_end,currency,gross_pay,deductions,net_pay,usd_per_unit,zwg_per_unit
employee@example.test,2026-09-01,2026-09-30,ZWG,1200.00,200.00,1000.00,0.0008,1
```

Use either `email` or `company_number` to identify an active employee. Dates use `YYYY-MM-DD`; gross pay minus deductions must equal net pay. FX values are snapshots supplied by payroll; the sample rates are fictional and are not for real payroll.

```bash
docker compose exec backend npm run import -- /app/imports/payroll_run.csv
```

A matching employee and pay period is updated rather than duplicated.

## Run services locally

Start PostgreSQL with `docker compose up -d db`. In one terminal:

```bash
cd backend
npm ci
npm run migrate
TRUST_PROXY=true npm run dev
```

In a second terminal:

```bash
cd frontend
npm ci
npm run dev
```

Vite runs at <http://localhost:8000> and proxies `/api` to the backend on port `5000`. The backend loads the repository-root `.env` automatically.

## Tests

```bash
npm --prefix backend test
npm --prefix frontend run lint
npm --prefix frontend run build
```

Use HTTPS, managed secrets, database backups, monitoring, and a reviewed account-recovery process before handling real payroll.
