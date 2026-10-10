CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  employee_number TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  totp_secret_encrypted TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE employees ALTER COLUMN totp_secret_encrypted DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS employees_email_lower_idx ON employees (LOWER(email));

ALTER TABLE employees
  ALTER COLUMN email DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS company_number TEXT,
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('admin', 'employee')),
  ADD COLUMN IF NOT EXISTS national_id TEXT,
  ADD COLUMN IF NOT EXISTS job_title TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS bank_change_note TEXT,
  ADD COLUMN IF NOT EXISTS department TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS bank_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS bank_account TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS basic_salary NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (basic_salary >= 0),
  ADD COLUMN IF NOT EXISTS housing_allowance NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (housing_allowance >= 0),
  ADD COLUMN IF NOT EXISTS transport_allowance NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (transport_allowance >= 0),
  ADD COLUMN IF NOT EXISTS other_allowances NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (other_allowances >= 0),
  ADD COLUMN IF NOT EXISTS default_deductions NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (default_deductions >= 0),
  ADD COLUMN IF NOT EXISTS nssa_exempt BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS leave_balance NUMERIC(8, 2) NOT NULL DEFAULT 0 CHECK (leave_balance >= 0);

UPDATE employees
SET company_number = UPPER(employee_number),
    employee_number = UPPER(employee_number)
WHERE company_number IS NULL OR company_number = '';

ALTER TABLE employees ALTER COLUMN company_number SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS employees_company_number_upper_idx
  ON employees (UPPER(company_number));

CREATE TABLE IF NOT EXISTS payslips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  currency CHAR(3) NOT NULL,
  gross_pay NUMERIC(14, 2) NOT NULL CHECK (gross_pay >= 0),
  deductions NUMERIC(14, 2) NOT NULL CHECK (deductions >= 0),
  net_pay NUMERIC(14, 2) NOT NULL CHECK (net_pay >= 0),
  usd_per_unit NUMERIC(20, 10) NOT NULL CHECK (usd_per_unit > 0),
  zwg_per_unit NUMERIC(20, 10) NOT NULL CHECK (zwg_per_unit > 0),
  earnings_json JSONB,
  statutory_json JSONB,
  settings_snapshot JSONB,
  employee_snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (period_end >= period_start),
  UNIQUE (employee_id, period_start, period_end)
);

ALTER TABLE payslips DROP CONSTRAINT IF EXISTS payslips_net_pay_check;

CREATE TABLE IF NOT EXISTS payroll_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  settings JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'locked')),
  settings_snapshot JSONB,
  totals_snapshot JSONB,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (period_start, period_end),
  CHECK (period_end >= period_start),
  CHECK ((status = 'draft' AND locked_at IS NULL) OR (status = 'locked' AND locked_at IS NOT NULL))
);

ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS locked_by TEXT;

CREATE TABLE IF NOT EXISTS payroll_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  earnings_json JSONB NOT NULL DEFAULT '{}'::JSONB,
  calculation_json JSONB,
  employee_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, employee_id)
);

ALTER TABLE payslips
  ADD COLUMN IF NOT EXISTS earnings_json JSONB,
  ADD COLUMN IF NOT EXISTS statutory_json JSONB,
  ADD COLUMN IF NOT EXISTS settings_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS employee_snapshot JSONB;

CREATE INDEX IF NOT EXISTS payroll_lines_run_idx ON payroll_lines (run_id);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_id UUID PRIMARY KEY,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payslips_employee_period_idx
  ON payslips (employee_id, period_end DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,
  event TEXT NOT NULL,
  ip_address INET,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_logs_employee_created_idx
  ON audit_logs (employee_id, created_at DESC);
