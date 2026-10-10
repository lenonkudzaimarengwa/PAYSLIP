import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, BadgeCheck, CalendarDays, Eye, EyeOff, FileSpreadsheet, FileText, Home, Landmark, LogOut, Menu, Search, Settings2, ShieldCheck, Users, X } from 'lucide-react'
import { unzipSync } from 'fflate'
import { calcLine, DEFAULT_SETTINGS } from '../../backend/src/lib/payroll/zim-paye.ts'
import './App.css'

const today = new Date()
const currentYear = String(today.getFullYear())
const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
const initialPayrollRates = {
  ...DEFAULT_SETTINGS,
  companyName: '',
  companyAddress: '',
  payeNumber: '',
  nssaSsr: '',
}
const payrollInputs = [
  ['overtime', 'Overtime'],
  ['bonus', 'Bonus'],
  ['loan', 'Loan recovery'],
  ['otherDeduction', 'Other deduction'],
]
const profileFields = [
  ['companyNumber', 'Company number', 'text'],
  ['fullName', 'Full name', 'text'],
  ['email', 'Email', 'email'],
  ['nationalId', 'National ID (optional)', 'text'],
  ['department', 'Department', 'text'],
  ['jobTitle', 'Job title', 'text'],
  ['bankName', 'Bank', 'text'],
  ['accountNumber', 'Account number', 'text'],
  ['basic', 'Basic salary (USD)', 'number'],
  ['housing', 'Housing (USD)', 'number'],
  ['transport', 'Transport (USD)', 'number'],
  ['otherAllowance', 'Other allowance (USD)', 'number'],
  ['leaveBalance', 'Leave balance (days)', 'number'],
]

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'include',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const body = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(body?.error || `Request failed (${response.status})`)
    error.status = response.status
    error.mustChangePassword = body?.mustChangePassword === true
    throw error
  }
  return body
}

function go(path, replace = false) {
  if (replace) window.history.replaceState({}, '', path)
  else window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function dateLabel(value, options = { month: 'long', year: 'numeric' }) {
  return new Intl.DateTimeFormat('en', { ...options, timeZone: 'UTC' }).format(new Date(value))
}

function money(value) {
  return new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(Number(value || 0))
}

function displayMoney(value) {
  return value === null || value === undefined || value === '' ? '—' : money(value)
}

function slipDeductions(slip) {
  const calculation = slip.statutory_json
  if (!calculation) return Number(slip.deductions || 0)
  return ['nssaEmployee', 'paye', 'aidsLevy', 'loan', 'otherDeduction']
    .reduce((total, key) => total + Number(calculation[key] || 0), 0)
}

function App() {
  const [location, setLocation] = useState(`${window.location.pathname}${window.location.search}`)
  const [theme, setTheme] = useState(() => document.documentElement.classList.contains('dark') ? 'dark' : 'light')
  const [account, setAccount] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loginError, setLoginError] = useState('')
  const [notice, setNotice] = useState('')
  const [loginRole, setLoginRole] = useState('employee')

  function changeTheme(nextTheme) {
    setTheme(nextTheme)
    document.documentElement.classList.toggle('dark', nextTheme === 'dark')
    document.documentElement.style.colorScheme = nextTheme
    try {
      window.localStorage.setItem('payslip-theme', nextTheme)
    } catch (storageError) {
      console.error('Unable to save the theme preference.', storageError)
    }
  }

  useEffect(() => {
    const onPop = () => setLocation(`${window.location.pathname}${window.location.search}`)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    let active = true
    api('/api/auth/me').then((result) => {
      if (active) setAccount(result.employee)
    }).catch(() => {
      if (!active) return
      setAccount(null)
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (loading) return
    const path = window.location.pathname
    if (!account) {
      if (path !== '/login') go('/login', true)
      return
    }
    if (account.mustChangePassword) {
      if (path !== '/change-password') go('/change-password', true)
      return
    }
    if (path === '/login' || path === '/') {
      go(account.role === 'admin' ? '/admin' : '/me', true)
      return
    }
    if (path === '/change-password') return
    if (path.startsWith('/admin') && account.role !== 'admin') {
      go('/me', true)
      return
    }
    if (path.startsWith('/me') && account.role !== 'employee') {
      go('/admin', true)
      return
    }
    if (!path.startsWith('/admin') && !path.startsWith('/me')) go(account.role === 'admin' ? '/admin' : '/me', true)
  }, [account, loading, location])

  async function signIn(event) {
    event.preventDefault()
    setBusy(true)
    setLoginError('')
    const form = new FormData(event.currentTarget)
    try {
      const result = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          companyNumber: String(form.get('companyNumber') || '').trim().toUpperCase(),
          password: form.get('password'),
          role: loginRole,
        }),
      })
      setAccount(result.employee)
      go(result.employee.mustChangePassword ? '/change-password' : result.employee.role === 'admin' ? '/admin' : '/me', true)
    } catch (requestError) {
      setLoginError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  const signOut = useCallback(async () => {
    setBusy(true)
    try {
      await api('/api/auth/logout', { method: 'POST' })
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setAccount(null)
      setBusy(false)
      go('/login', true)
    }
  }, [])

  async function changePassword(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const form = new FormData(event.currentTarget)
    try {
      const result = await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: form.get('currentPassword'),
          newPassword: form.get('newPassword'),
          confirmPassword: form.get('confirmPassword'),
        }),
      })
      setAccount((current) => current ? { ...current, mustChangePassword: false } : current)
      setNotice('Password saved.')
      go(result.home, true)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className="loading-screen"><span className="loader" />Loading your account</div>
  if (!account && window.location.pathname !== '/login') return null
  if (account?.mustChangePassword || window.location.pathname === '/change-password') {
    return <PasswordPage account={account} forced={account?.mustChangePassword} busy={busy} error={error} onSubmit={changePassword} onSignOut={signOut} />
  }
  if (!account) return <LoginPage theme={theme} onThemeChange={changeTheme} busy={busy} error={loginError} role={loginRole} onRoleChange={(role) => {
    setLoginRole(role)
    setLoginError('')
  }} onSubmit={signIn} />

  return <AuthenticatedPortal
    account={account}
    theme={theme}
    onThemeChange={changeTheme}
    path={window.location.pathname}
    search={window.location.search}
    busy={busy}
    error={error}
    notice={notice}
    setError={setError}
    setNotice={setNotice}
    onSignOut={signOut}
  />
}

function ThemeToggle({ theme, onChange, className = '' }) {
  const dark = theme === 'dark'
  return <button className={`theme-toggle ${className}`} type="button" role="switch" aria-checked={dark}
    onClick={() => onChange(dark ? 'light' : 'dark')}>
    <span className="theme-toggle-track"><span /></span>
    <span>Dark mode</span>
  </button>
}

function LoginPage({ theme, onThemeChange, busy, error, role, onRoleChange, onSubmit }) {
  const [showPassword, setShowPassword] = useState(false)
  return <main className="login-shell login-page">
    <section className="login-panel">
      <a className="login-brand" href="/login" aria-label="Payslip sign in"><Landmark size={20} /><span>payslip<span>.</span></span></a>
      <div className="login-copy">
        <h1>Sign in</h1>
        <p className="login-role-helper">{role === 'employee' ? 'Your payslips' : 'Payroll office'}</p>
        <div className="login-role-choice" role="group" aria-label="Choose sign-in area">
          {[
            ['employee', 'Employee'],
            ['admin', 'Admin'],
          ].map(([value, label]) => <button
            key={value}
            className={`login-role-option ${role === value ? 'selected' : ''}`}
            type="button"
            aria-pressed={role === value}
            onClick={() => onRoleChange(value)}
          >{label}</button>)}
        </div>
      </div>
      <form className="login-form" onSubmit={onSubmit}>
        <label htmlFor="companyNumber">{role === 'employee' ? 'Employee number' : 'Company number'}</label>
        <input id="companyNumber" name="companyNumber" type="text" autoComplete="username"
          placeholder={role === 'employee' ? 'Enter employee number' : 'Enter company number'} required />
        <label htmlFor="password">Password</label>
        <div className="login-password-field">
          <input id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required />
          <button type="button" className="password-visibility" aria-label={showPassword ? 'Hide password' : 'Show password'}
            aria-pressed={showPassword} onClick={() => setShowPassword((visible) => !visible)}>
            {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button login-button" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'} <ArrowUpRight size={16} /></button>
      </form>
      <button className="login-theme-toggle" type="button" aria-pressed={theme === 'dark'}
        onClick={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')}>
        Dark mode: {theme === 'dark' ? 'On' : 'Off'}
      </button>
      <div className="login-footer">Authorised users only.</div>
    </section>
  </main>
}

function PasswordPage({ account, forced, busy, error, onSubmit, onSignOut }) {
  return <main className="login-shell">
    <section className="login-panel">
      <a className="brand" href="#"><span className="brand-mark"><Landmark size={19} /></span><span>payslip<span className="brand-period">.</span></span></a>
      <div className="login-copy"><span className="eyebrow"><ShieldCheck size={14} /> PASSWORD SECURITY</span><h1>Set your password</h1>
        <p>{forced ? `Welcome, ${account?.fullName || 'user'}. Choose a private password before continuing.` : 'Update your private password.'}</p></div>
      <form className="login-form" onSubmit={onSubmit}>
        {!forced && <><label htmlFor="currentPassword">Current password</label><input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required /></>}
        <label htmlFor="newPassword">New password</label><input id="newPassword" name="newPassword" type="password" autoComplete="new-password" minLength={8} required />
        <label htmlFor="confirmPassword">Confirm new password</label><input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" minLength={8} required />
        <span className="password-hint">At least 8 characters, including one letter and one number. Do not use your company number.</span>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button login-button" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
      </form>
      {forced && <button className="text-action" onClick={onSignOut}>Sign out</button>}
    </section>
    <aside className="login-aside"><div className="aside-content"><span className="aside-index">PRIVATE ACCOUNT</span><div className="aside-quote">Your pay data,<br /><span>kept personal.</span></div></div></aside>
  </main>
}

function AuthenticatedPortal({ account, theme, onThemeChange, path, search, busy, error, notice, setError, setNotice, onSignOut }) {
  const isAdmin = account.role === 'admin'
  const [month, setMonth] = useState(new URLSearchParams(search).get('month') || currentMonth)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [rates, setRates] = useState(initialPayrollRates)
  const [run, setRun] = useState(null)
  const [people, setPeople] = useState([])
  const [personSearch, setPersonSearch] = useState('')
  const [editingPerson, setEditingPerson] = useState(null)
  const [personSaving, setPersonSaving] = useState(false)
  const personSaveInFlight = useRef(false)
  const [temporaryPassword, setTemporaryPassword] = useState(null)
  const [employeeData, setEmployeeData] = useState(null)
  const [employeeSlips, setEmployeeSlips] = useState([])
  const [selectedSlip, setSelectedSlip] = useState(null)
  const [employeeLoading, setEmployeeLoading] = useState(true)
  const [employeeLoadError, setEmployeeLoadError] = useState(false)
  const [returnsData, setReturnsData] = useState(null)
  const [activeEmployeeCount, setActiveEmployeeCount] = useState(0)
  const [emailReport, setEmailReport] = useState(null)

  const page = isAdmin
    ? path === '/admin/people' ? 'people'
      : path === '/admin/import-excel' ? 'import'
        : path === '/admin/run' ? 'run'
        : path === '/admin/payslips' ? 'payslips'
          : path === '/admin/returns' ? 'returns'
            : path === '/admin/rates' ? 'rates' : 'home'
    : path === '/me/details' ? 'details'
      : path === '/me/payslip' ? 'payslip' : 'me'
  const selectedCompanyNumber = isAdmin && page === 'people'
    ? new URLSearchParams(search).get('companyNumber')?.trim().toUpperCase()
    : ''

  const setFailure = useCallback((message) => {
    setError(message)
    setNotice('')
  }, [setError, setNotice])

  const refreshPeople = useCallback(async () => {
    const result = await api(`/api/admin/people?search=${encodeURIComponent(personSearch)}`)
    setPeople(result.people)
  }, [personSearch])

  const refreshRates = useCallback(async () => {
    const result = await api('/api/payroll/settings')
    setRates({ ...initialPayrollRates, ...result.settings })
  }, [])

  const refreshActiveEmployeeCount = useCallback(async () => {
    const result = await api('/api/payroll/employees')
    setActiveEmployeeCount(result.employees.length)
  }, [])

  const refreshRun = useCallback(async (monthValue = month) => {
    try {
      const result = await api(`/api/payroll/runs/${monthValue}`)
      setRun(normalizeRun(result.run))
    } catch (requestError) {
      if (requestError.status === 404) {
        setRun(null)
        return
      }
      throw requestError
    }
  }, [month])

  function openAdminPayslip(monthValue, employeeId) {
    setMonth(monthValue)
    go(`/admin/payslips?month=${encodeURIComponent(monthValue)}&employeeId=${encodeURIComponent(employeeId)}`)
  }

  function openManagementEmployee(companyNumber) {
    go(`/admin/people?companyNumber=${encodeURIComponent(companyNumber)}&month=${encodeURIComponent(month)}`)
  }

  const refreshEmployeeData = useCallback(async () => {
    setEmployeeLoading(true)
    setEmployeeLoadError(false)
    try {
      const [profileResult, slipsResult] = await Promise.allSettled([
        api('/api/me'),
        api('/api/me/payslips'),
      ])
      const failures = [profileResult, slipsResult]
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason)
      if (failures.some((failure) => failure.status === 401 || failure.status === 403)) {
        await onSignOut()
        return
      }
      const failure = failures.find((item) => item.status !== 404)
      if (failure) throw failure

      const profile = profileResult.status === 'fulfilled' ? profileResult.value.employee : null
      const slips = slipsResult.status === 'fulfilled' ? slipsResult.value.payslips : []
      setEmployeeData(profile || {
        company_number: account.companyNumber || 'Not set',
        full_name: account.fullName || 'Employee',
      })
      setEmployeeSlips(slips)
      const targetMonth = page === 'payslip' ? new URLSearchParams(search).get('month') : null
      const selected = targetMonth
        ? slips.find((slip) => String(slip.period_start).startsWith(targetMonth))
        : slips[0]
      setSelectedSlip(selected || null)
    } catch {
      setEmployeeLoadError(true)
    } finally {
      setEmployeeLoading(false)
    }
  }, [account.companyNumber, account.fullName, onSignOut, page, search])

  useEffect(() => {
    let active = true
    async function load() {
      try {
        if (isAdmin) {
          if (page === 'people' || page === 'home') await refreshPeople()
          if (page === 'rates') await refreshRates()
          if (page === 'run' || page === 'home' || page === 'payslips' || page === 'returns') {
            await refreshRates()
            if (page === 'run') await refreshActiveEmployeeCount()
            await refreshRun()
          }
          if (page === 'returns') setReturnsData(await api(`/api/admin/month/${month}/returns`).catch((requestError) => {
            if (requestError.status === 404) return null
            throw requestError
          }))
        } else if (page === 'me' || page === 'details' || page === 'payslip') await refreshEmployeeData()
      } catch (requestError) {
        if (active) setFailure(requestError.message)
      }
    }
    load()
    return () => { active = false }
  }, [isAdmin, page, month, personSearch, refreshActiveEmployeeCount, refreshEmployeeData, refreshPeople, refreshRates, refreshRun, setFailure])

  useEffect(() => {
    if (isAdmin && page === 'returns') {
      api(`/api/admin/month/${month}/returns`).then(setReturnsData).catch((requestError) => {
        if (requestError.status === 404) setReturnsData(null)
        else setFailure(requestError.message)
      })
    }
  }, [isAdmin, month, page, setFailure])

  function changeMonth(value) {
    setMonth(value)
    const url = new URL(window.location.href)
    url.searchParams.set('month', value)
    go(`${url.pathname}${url.search}`)
  }

  async function runAction(action, confirmation) {
    if (confirmation && !window.confirm(confirmation)) return
    setFailure('')
    setNotice('')
    if (action.sendPayslips) setEmailReport(null)
    try {
      const result = await api(action.path, { method: action.method || 'POST', ...(action.body ? { body: JSON.stringify(action.body) } : {}) })
      if (result.run) setRun(normalizeRun(result.run))
      if (result.emailReport) setEmailReport(result.emailReport)
      if (action.refresh) await refreshRun()
      if (result.returns) setReturnsData(result)
      if (action.success) setNotice(action.success)
    } catch (requestError) {
      setFailure(requestError.message)
    }
  }

  async function submitPerson(event, onSaved) {
    event.preventDefault()
    if (personSaveInFlight.current) return
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const data = Object.fromEntries(form.entries())
    data.companyNumber = String(data.companyNumber || '').trim().toUpperCase()
    data.fullName = String(data.fullName || '').trim()
    for (const key of ['basic', 'housing', 'transport', 'otherAllowance', 'leaveBalance']) data[key] = form.get(key) || '0'
    data.nssaExempt = form.get('nssaExempt') === 'on'
    data.active = editingPerson?.id ? form.has('active') : true
    const invalidField = !data.companyNumber
      ? ['companyNumber', 'Enter a valid company number.']
      : !data.fullName
        ? ['fullName', 'Enter the full name.']
        : !Number.isFinite(Number(data.basic)) || Number(data.basic) < 0
          ? ['basic', 'Basic salary must be zero or more.']
          : null
    if (invalidField) {
      setFailure(invalidField[1])
      formElement.elements.namedItem(invalidField[0])?.focus()
      return
    }
    setFailure('')
    personSaveInFlight.current = true
    setPersonSaving(true)
    try {
      const isEditing = Boolean(editingPerson?.id)
      const response = await api(isEditing ? `/api/admin/people/${editingPerson.id}` : '/api/admin/people', {
        method: isEditing ? 'PATCH' : 'POST',
        body: JSON.stringify(data),
      })
      setEditingPerson(null)
      setTemporaryPassword(null)
      setNotice(isEditing ? 'Person saved.' : `Account created. Provide the temporary password privately to ${response.person.full_name}.`)
      if (onSaved) onSaved(response.person)
      else await refreshPeople()
    } catch (requestError) {
      setFailure(requestError.message)
      const fieldName = requestError.message === 'Enter the full name.' ? 'fullName'
        : requestError.message === 'Enter a valid email address.' ? 'email'
        : requestError.message === 'Basic salary must be zero or more.' ? 'basic'
          : requestError.message === 'Enter a valid company number.' ? 'companyNumber' : null
      if (fieldName) formElement.elements.namedItem(fieldName)?.focus()
    } finally {
      personSaveInFlight.current = false
      setPersonSaving(false)
    }
  }

  async function resetPassword(person) {
    setFailure('')
    try {
      const result = await api(`/api/admin/people/${person.id}/reset-password`, { method: 'POST' })
      setTemporaryPassword({ name: person.full_name, password: result.temporaryPassword, message: result.message })
      await refreshPeople()
    } catch (requestError) {
      setFailure(requestError.message)
    }
  }

  async function changeBankRequest(action, person) {
    const confirmed = action === 'accept'
      ? window.confirm(`Accept the bank change request from ${person.full_name}?`)
      : window.confirm(`Dismiss the bank change request from ${person.full_name}?`)
    if (!confirmed) return
    try {
      await api(`/api/admin/people/${person.id}/bank-change/${action}`, { method: 'POST' })
      await refreshPeople()
      setNotice(action === 'accept' ? 'Bank details updated.' : 'Bank change request dismissed.')
    } catch (requestError) {
      setFailure(requestError.message)
    }
  }

  async function savePayrollLine(line) {
    try {
      const response = await api(`/api/payroll/runs/${run.id}/lines/${line.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ earnings: line.earnings }),
      })
      setRun((current) => normalizeRun({
        ...current,
        lines: current.lines.map((item) => item.id === line.id ? { ...item, earnings: response.earnings, calculation: response.calculation } : item),
      }))
    } catch (requestError) {
      setFailure(requestError.message)
    }
  }

  function changePayrollInput(lineId, key, value) {
    setRun((current) => {
      if (!current) return current
      return {
        ...current,
        lines: current.lines.map((line) => {
          if (line.id !== lineId) return line
          const earnings = { ...line.earnings, [key]: value === '' ? '' : Number(value) }
          const invalid = payrollInputs.some(([name]) => !Number.isFinite(Number(earnings[name])) || Number(earnings[name]) < 0)
          return { ...line, earnings, calculation: invalid ? line.calculation : calcLine(earnings, rates) }
        }),
      }
    })
  }

  async function saveRates(event) {
    event.preventDefault()
    try {
      const result = await api('/api/payroll/settings', { method: 'PUT', body: JSON.stringify({ settings: rates }) })
      setRates({ ...initialPayrollRates, ...result.settings })
      await refreshRun()
      setNotice('Rates saved.')
    } catch (requestError) {
      setFailure(requestError.message)
    }
  }

  async function employeeBankRequest(event) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    try {
      await api('/api/me/details/bank', {
        method: 'PATCH',
        body: JSON.stringify({ bankName: form.get('bankName'), accountNumber: form.get('accountNumber') }),
      })
      setNotice('Bank change requested. Paid bank details are unchanged until payroll accepts the request.')
      await refreshEmployeeData()
    } catch (requestError) {
      setFailure(requestError.message)
    }
  }

  const headline = page === 'home' && isAdmin ? 'Dashboard'
    : page === 'people' ? selectedCompanyNumber ? 'Employee record' : 'People'
    : page === 'import' ? 'Import Excel'
    : page === 'run' ? 'Run payroll'
      : page === 'payslips' ? 'Payslips'
        : page === 'returns' ? 'Returns'
          : page === 'rates' ? 'Rates'
            : page === 'details' ? 'My details'
              : page === 'payslip' ? 'My payslip' : isAdmin ? 'Payroll' : 'My pay'
  const adminNav = [
    ['/admin', 'Dashboard', Home],
    ['/admin/people', 'People', Users],
    ['/admin/import-excel', 'Import Excel', FileSpreadsheet],
    ['/admin/run', 'Run payroll', CalculatorIcon],
    ['/admin/payslips', 'Payslips', FileText],
    ['/admin/returns', 'Returns', Landmark],
    ['/admin/rates', 'Rates', Settings2],
  ]
  const employeeNav = [['/me', 'My pay', Home], ['/me/details', 'My details', Users], ['/me/payslip', 'Payslips', FileText], ['/change-password', 'Change password', Settings2]]
  const nav = isAdmin ? adminNav : employeeNav
  const mobileNav = isAdmin
    ? [['/admin/people', 'People', Users], ['/admin/run', 'Run', CalculatorIcon], ['/admin/returns', 'Returns', Landmark], ['/admin/rates', 'Rates', Settings2]]
    : [['/me', 'My pay', Home], ['/me/payslip', 'Payslips', FileText], ['/me/details', 'Details', Users], ['/change-password', 'Password', Settings2]]
  const filteredPeople = useMemo(() => people, [people])
  const latestEmployeeSlip = employeeSlips[0]

  return <div className="app-shell">
    <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
      <a className="brand sidebar-brand" href={isAdmin ? '/admin' : '/me'} onClick={(event) => { event.preventDefault(); go(isAdmin ? '/admin' : '/me') }}>
        <span className="brand-mark"><Landmark size={19} /></span><span>payslip<span className="brand-period">.</span></span>
      </a>
      <div className="workspace-label">{isAdmin ? 'MANAGEMENT' : 'EMPLOYEE'}</div>
      <nav className="main-nav" aria-label="Main navigation">{nav.map(([href, label, Icon]) => <a key={href} href={href}
        className={`nav-item ${path === href || (href === '/me' && path === '/') ? 'active' : ''}`} onClick={(event) => { event.preventDefault(); go(href); setMobileOpen(false) }}>
        <Icon size={17} /> {label}
      </a>)}</nav>
      <div className="sidebar-bottom">
        <ThemeToggle theme={theme} onChange={onThemeChange} />
        <div className="security-note"><span className="security-icon"><ShieldCheck size={16} /></span><span><strong>{account.role === 'admin' ? 'Payroll admin' : 'Account secured'}</strong><small>{account.companyNumber || 'Not set'}</small></span><BadgeCheck className="verified-mark" size={15} /></div>
        <button className="profile-row" onClick={onSignOut}><span className="avatar">{account.fullName.split(/\s+/).map((word) => word[0]).slice(0, 2).join('').toUpperCase()}</span><span className="profile-meta"><strong>{account.fullName}</strong><small>{account.companyNumber || 'Not set'}</small></span><LogOut size={16} /></button>
      </div>
    </aside>
    {mobileOpen && <button className="mobile-backdrop" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
    <main className="main-area">
      <header className="topbar">
        <button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Menu size={19} /></button>
        <div className="breadcrumb">{isAdmin ? 'Management' : 'My workspace'} <span>/</span> <strong>{headline}</strong></div>
        <ThemeToggle theme={theme} onChange={onThemeChange} className="mobile-theme-toggle" />
        <div className="topbar-actions">
          {isAdmin && page !== 'home' && <label className="month-control">Month<input type="month" value={month} onChange={(event) => changeMonth(event.target.value)} /></label>}
          <span className="topbar-date"><CalendarDays size={15} /> {dateLabel(`${month}-01`, { month: 'short', year: 'numeric' })}</span>
          <button className="icon-button logout-small" title="Sign out" aria-label="Sign out" onClick={onSignOut}><LogOut size={17} /></button>
        </div>
      </header>
      <div className="content-wrap">
        {isAdmin && page === 'home' ? <section className="admin-dashboard-heading">
          <h1>Dashboard</h1>
          <label className="month-control">Month<input type="month" value={month} onChange={(event) => changeMonth(event.target.value)} /></label>
          <button className="text-action" onClick={() => go(`/admin/run?month=${encodeURIComponent(month)}`)}>Run payroll <ArrowUpRight size={15} /></button>
        </section> : <section className="welcome-row"><div><span className="eyebrow muted-eyebrow">{isAdmin ? 'PAYROLL MANAGEMENT' : 'EMPLOYEE SELF-SERVICE'} <span className="eyebrow-dot" /></span><h1>{headline}</h1>
          <p>{isAdmin ? dateLabel(`${month}-01`, { month: 'long', year: 'numeric' }) : page === 'me'
            ? `${employeeData?.full_name || account.fullName} · ${employeeData?.company_number || account.companyNumber || 'Not set'}`
            : account.fullName}</p></div></section>}
        {isAdmin && error && <div className="notice-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss"><X size={16} /></button></div>}
        {!isAdmin && employeeLoadError && <div className="notice-error employee-load-error" role="alert">
          <span>Unable to load your pay. Try again.</span>
          <button className="secondary-button" onClick={refreshEmployeeData} disabled={employeeLoading}>Retry</button>
        </div>}
        {notice && <div className="notice-success" role="status"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss"><X size={16} /></button></div>}

        {isAdmin && page === 'home' && <AdminHome run={run} people={people} rates={rates}
          month={month} open={(path) => go(path)} onOpenPayslip={openAdminPayslip} />}
        {isAdmin && page === 'people' && selectedCompanyNumber && <ManagementEmployeePage
          key={selectedCompanyNumber}
          companyNumber={selectedCompanyNumber}
          month={month}
          onSubmit={submitPerson}
          busy={personSaving}
          error={error}
          onBack={() => go(`/admin/payslips?month=${encodeURIComponent(month)}`)}
        />}
        {isAdmin && page === 'people' && !selectedCompanyNumber && <PeoplePage
          people={filteredPeople} query={personSearch} setQuery={setPersonSearch} editing={editingPerson} setEditing={setEditingPerson}
          temporaryPassword={temporaryPassword} setTemporaryPassword={setTemporaryPassword} onSubmit={submitPerson}
          onReset={resetPassword} onBankChange={changeBankRequest} account={account} onReload={refreshPeople}
          error={error} clearError={() => setError('')} personSaving={personSaving} onOpenEmployee={openManagementEmployee}
        />}
        {isAdmin && page === 'import' && <ImportExcelPage onImported={refreshPeople} />}
        {isAdmin && page === 'run' && <RunPayrollPage month={month} run={run} busy={busy} activeEmployeeCount={activeEmployeeCount} emailReport={emailReport} onCreate={() => runAction({ path: '/api/payroll/runs', method: 'POST', body: { month }, refresh: true })} onChange={changePayrollInput} onSave={savePayrollLine}
          onLock={() => runAction({ path: `/api/payroll/runs/${run?.id}/lock`, refresh: true, sendPayslips: true }, `Confirm ${dateLabel(`${month}-01`)} and email each active employee their own payslip? You can unlock the month if needed.`)}
          onUnlock={() => runAction({ path: `/api/payroll/runs/${run?.id}/unlock`, refresh: true }, `Unlock ${dateLabel(`${month}-01`)}? Figures will calculate again from current salaries and rates.`)}
        />}
        {isAdmin && page === 'payslips' && <AdminPayslipsPage run={run} rates={rates} search={search} onViewEmployee={openManagementEmployee} />}
        {isAdmin && page === 'returns' && <ReturnsPage data={returnsData} month={month} />}
        {isAdmin && page === 'rates' && <RatesPage rates={rates} setRates={setRates} onSave={saveRates} onReset={() => {
          if (window.confirm('Restore 2026 USD defaults? This only resets company and statutory rate fields. Employees are unchanged.')) setRates(initialPayrollRates)
        }} />}

        {!isAdmin && !employeeLoadError && page === 'me' && (employeeLoading ? <div className="loading-inline"><span className="loader" />Loading your pay</div> : <MyPayPage
          latest={latestEmployeeSlip}
          slips={employeeSlips}
          companyNumber={employeeData?.company_number || account.companyNumber}
          leaveBalance={employeeData?.leave_balance}
          onOpen={(monthValue) => go(`/me/payslip?month=${monthValue}`)}
        />)}
        {!isAdmin && !employeeLoadError && page === 'details' && (employeeLoading ? <div className="loading-inline"><span className="loader" />Loading your details</div> : employeeData && <MyDetailsPage employee={employeeData} onSubmit={employeeBankRequest} />)}
        {!isAdmin && !employeeLoadError && page === 'payslip' && (employeeLoading ? <div className="loading-inline"><span className="loader" />Loading your payslip</div> : <EmployeePayslipPage slip={selectedSlip} onBack={() => go('/me')} />)}
        <footer className="page-footer"><span><ShieldCheck size={14} /> Private payroll information.</span><span>{isAdmin ? 'Authorized payroll access' : 'Only you can see your payslips.'}</span></footer>
      </div>
    </main>
    <nav className="mobile-bottom-nav" aria-label="Mobile navigation">{mobileNav.map(([href, label, Icon]) => <a key={href} href={href}
      className={`mobile-nav-item ${path === href || (href === '/me' && path === '/') ? 'active' : ''}`}
      onClick={(event) => { event.preventDefault(); go(href) }}>
      <Icon size={17} /><span>{label}</span>
    </a>)}</nav>
  </div>
}

function CalculatorIcon(props) {
  return <span className="nav-calculator" aria-hidden="true" {...props}>▦</span>
}

function normalizeRun(run) {
  if (!run) return null
  return { ...run, lines: run.lines.map((line) => ({ ...line, savedEarnings: { ...line.earnings } })) }
}

function payrollTotals(lines = []) {
  return lines.reduce((summary, line) => {
    summary.gross += line.calculation.gross
    summary.paye += line.calculation.paye
    summary.aids += line.calculation.aidsLevy
    summary.employeeNssa += line.calculation.nssaEmployee
    summary.employerNssa += line.calculation.nssaEmployer
    summary.net += line.calculation.net
    return summary
  }, { gross: 0, paye: 0, aids: 0, employeeNssa: 0, employerNssa: 0, net: 0 })
}

function AdminHome({ run, people, rates, month, open, onOpenPayslip }) {
  const lines = run?.lines || []
  const totals = payrollTotals(lines)
  const activePeople = people.filter((person) => person.active)
  const attention = [
    [activePeople.filter((person) => Number(person.basic_salary || 0) <= 0).length, 'People without basic salary', '/admin/people'],
    [activePeople.filter((person) => Boolean(person.bank_change_note)).length, 'Bank change requests', '/admin/people'],
    [activePeople.filter((person) => !person.bank_account).length, 'Missing bank accounts', '/admin/people'],
  ].filter(([count]) => count > 0)
  if (run?.status !== 'locked') attention.push([1, 'Month not locked', '/admin/run'])
  const due = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 10))
  const orderedLines = [...lines].sort((a, b) => a.company_number.localeCompare(b.company_number))
  const locked = run?.status === 'locked'
  return <section className="admin-dashboard">
    <p className="admin-dashboard-subtitle">
      {rates.companyName || 'Company name not set'} · {dateLabel(`${month}-01`)} · {locked ? 'Confirmed' : 'Draft'}
    </p>
    <div className="dashboard-figure-band" aria-label="Payroll totals">
      {[
        ['Headcount', String(lines.length)],
        ['Wage bill', money(totals.gross)],
        ['PAYE + AIDS levy', money(totals.paye + totals.aids)],
        ['NSSA · both sides', money(totals.employeeNssa + totals.employerNssa)],
        ['Net to pay', money(totals.net)],
      ].map(([label, value]) => <div className="dashboard-figure" key={label}>
        <span>{label}</span><strong>{value}</strong>
        {label === 'PAYE + AIDS levy' && <small>Due {dateLabel(due, { day: 'numeric', month: 'long' })}</small>}
      </div>)}
    </div>
    {!activePeople.length && <p className="dashboard-no-people">Add people before running this month.</p>}
    <div className="dashboard-columns">
      <section className="panel dashboard-month-panel">
        <header><h2>This month</h2><span>{lines.length} people in run</span></header>
        {orderedLines.length ? <div className="dashboard-run-scroll">
          <table className="dashboard-run-table">
            <thead><tr><th>Company number</th><th>Name</th><th>Net</th></tr></thead>
            <tbody>{orderedLines.map((line) => <tr key={line.id} role="link" tabIndex="0"
              aria-label={`Open ${line.full_name}'s payslip`}
              onClick={() => onOpenPayslip(month, line.employee_id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onOpenPayslip(month, line.employee_id)
                }
              }}>
              <td>{line.company_number}</td><td>{line.full_name}</td><td>{money(line.calculation.net)}</td>
            </tr>)}</tbody>
          </table>
        </div> : <p className="dashboard-empty-run">No people are in this month’s run.</p>}
        <footer><button className="text-action" onClick={() => open(`/admin/run?month=${encodeURIComponent(month)}`)}>Open run <ArrowUpRight size={14} /></button></footer>
      </section>
      <div className="dashboard-side-cards">
        <section className="panel dashboard-attention-panel">
          <h2>Needs attention</h2>
          {attention.length ? <ul>{attention.map(([count, label, path]) => <li key={label}>
            <button className="dashboard-attention-link" onClick={() => open(`${path}?month=${encodeURIComponent(month)}`)}>
              <span>{label}</span><strong>{count}</strong>
            </button>
          </li>)}</ul> : <p>Nothing waiting.</p>}
        </section>
        <section className="panel dashboard-filing-panel">
          <h2>Filing</h2>
          <div><span>PAYE number</span><strong>{rates.payeNumber || 'Not set'}</strong></div>
          <div><span>NSSA number</span><strong>{rates.nssaSsr || 'Not set'}</strong></div>
          <div><span>Month status</span><strong>{locked ? 'Confirmed' : 'Still open'}</strong></div>
          <button className="text-action" onClick={() => open(`/admin/returns?month=${encodeURIComponent(month)}`)}>Open returns <ArrowUpRight size={14} /></button>
        </section>
      </div>
    </div>
  </section>
}

function PeoplePage({ people, query, setQuery, editing, setEditing, temporaryPassword, setTemporaryPassword, onSubmit, onReset, onBankChange, account, onReload, error, clearError, personSaving, onOpenEmployee }) {
  const [pendingAction, setPendingAction] = useState(null)
  const openEditor = (person = null) => {
    setTemporaryPassword(null)
    clearError()
    setEditing(person ? {
      ...person,
      companyNumber: person.company_number,
      fullName: person.full_name,
      email: person.email || '',
      nationalId: person.national_id || '',
      jobTitle: person.job_title,
      bankName: person.bank_name,
      accountNumber: person.bank_account,
      basic: person.basic_salary,
      housing: person.housing_allowance,
      transport: person.transport_allowance,
      otherAllowance: person.other_allowances,
      leaveBalance: person.leave_balance ?? 0,
    } : {})
  }
  async function deactivate(person) {
    try {
      await api(`/api/admin/people/${person.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...person, companyNumber: person.company_number, fullName: person.full_name, nationalId: person.national_id, jobTitle: person.job_title, bankName: person.bank_name, accountNumber: person.bank_account, basic: person.basic_salary, housing: person.housing_allowance, transport: person.transport_allowance, otherAllowance: person.other_allowances, leaveBalance: person.leave_balance ?? 0, nssaExempt: person.nssa_exempt, active: false }),
      })
      await onReload()
    } catch (error) {
      window.alert(error.message)
    }
  }
  async function confirmPendingAction() {
    if (!pendingAction) return
    const { action, person } = pendingAction
    setPendingAction(null)
    if (action === 'reset') await onReset(person)
    else await deactivate(person)
  }

  return <section className="panel full-history-panel people-directory">
    <div className="history-toolbar">
      <div><span className="panel-kicker">EMPLOYEE DIRECTORY</span><h2>People <span className="history-total">{people.length}</span></h2></div>
      <div className="history-filters">
        <label className="search-field"><Search size={15} /><input aria-label="Search people" placeholder="Search number or name" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <button className="primary-button" onClick={() => openEditor()}>Add person</button>
      </div>
    </div>
    {temporaryPassword && <div className="temporary-password" role="status">
      <strong>Temporary password for {temporaryPassword.name}</strong><code>{temporaryPassword.password}</code><span>Copy this now. It will not be shown again.</span>
      <button className="secondary-button" onClick={() => setTemporaryPassword(null)}>Done</button>
    </div>}
    <div className="table-scroll"><table className="people-table">
      <thead><tr><th>COMPANY NUMBER</th><th>NAME</th><th>EMAIL</th><th>DEPARTMENT</th><th>TITLE</th><th>ROLE</th><th>BASIC (USD)</th><th>ACTIVE</th><th>ACTIONS</th></tr></thead>
      <tbody>{people.map((person) => <tr key={person.id}>
        <td data-label="Company number">{person.company_number}</td>
        <td data-label="Name"><button type="button" className="people-name-link" onClick={() => onOpenEmployee(person.company_number)}>{person.full_name}</button></td>
        <td data-label="Email">{person.email || '—'}</td><td data-label="Department">{person.department || '—'}</td><td data-label="Title">{person.job_title || '—'}</td>
        <td data-label="Role">{person.role}</td><td data-label="Basic (USD)">{money(person.basic_salary)}<small>Leave balance: {Number(person.leave_balance || 0).toFixed(2)} days</small></td><td data-label="Active">{person.active ? 'Active' : 'Inactive'}</td>
        <td data-label="Actions" className="people-actions">
          {person.bank_change_note && <><span className="bank-request-badge">Bank change requested</span><button className="text-action" onClick={() => onBankChange('accept', person)}>Accept</button><button className="text-action" onClick={() => onBankChange('dismiss', person)}>Dismiss</button></>}
          <div className="people-primary-actions">
            <button className="people-action-button edit-person-action" onClick={() => openEditor(person)}>Edit</button>
            <button className="people-action-button reset-person-action" onClick={() => setPendingAction({ action: 'reset', person })}>Reset password</button>
            {person.active && <button className="people-action-button deactivate-person-action" disabled={person.id === account.id} title={person.id === account.id ? 'You cannot deactivate the account you are using.' : undefined} onClick={() => setPendingAction({ action: 'deactivate', person })}>Deactivate</button>}
          </div>
        </td>
      </tr>)}</tbody>
    </table></div>
    {!people.length && <div className="empty-history">No people match your search.</div>}
    {pendingAction && <div className="modal-backdrop people-confirm-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingAction(null) }}>
      <section className="people-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="people-confirm-title" aria-describedby="people-confirm-message">
        <h2 id="people-confirm-title">{pendingAction.action === 'reset' ? 'Reset password' : 'Deactivate person'}</h2>
        <p id="people-confirm-message">{pendingAction.action === 'reset'
          ? `Reset the password for ${pendingAction.person.full_name}? They will need the new password to sign in.`
          : `Deactivate ${pendingAction.person.full_name}? They will not be able to sign in.`}</p>
        <footer>
          <button type="button" className="secondary-button" onClick={() => setPendingAction(null)}>Cancel</button>
          <button type="button" className={pendingAction.action === 'reset' ? 'primary-button people-confirm-reset' : 'primary-button people-confirm-deactivate'} onClick={confirmPendingAction}>
            {pendingAction.action === 'reset' ? 'Reset' : 'Deactivate'}
          </button>
        </footer>
      </section>
    </div>}
    {editing !== undefined && editing !== null && <PersonModal
      person={editing}
      error={error}
      busy={personSaving}
      onClose={() => { if (!personSaving) setEditing(null) }}
      onSubmit={onSubmit}
    />}
  </section>
}

function readXlsxRows(buffer) {
  let totalXmlBytes = 0
  const files = unzipSync(new Uint8Array(buffer), {
    filter(file) {
      if (file.originalSize > 10 * 1024 * 1024) throw new Error('A workbook XML file is too large.')
      if (!file.name.toLowerCase().endsWith('.xml')) return false
      totalXmlBytes += file.originalSize
      if (totalXmlBytes > 30 * 1024 * 1024) throw new Error('The workbook contains too much XML data.')
      return true
    },
  })
  const decoder = new TextDecoder()
  const parseXml = (name) => {
    const content = files[name]
    if (!content) throw new Error('The workbook is missing required Excel data.')
    const document = new DOMParser().parseFromString(decoder.decode(content), 'application/xml')
    if (document.querySelector('parsererror')) throw new Error('The workbook contains invalid XML.')
    return document
  }
  const workbook = parseXml('xl/workbook.xml')
  const firstSheet = workbook.getElementsByTagName('sheet')[0]
  if (!firstSheet) throw new Error('The workbook does not contain a worksheet.')
  const relationshipId = firstSheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
    || firstSheet.getAttribute('r:id')
  const relationships = parseXml('xl/_rels/workbook.xml.rels')
  const relation = [...relationships.getElementsByTagName('Relationship')]
    .find((item) => item.getAttribute('Id') === relationshipId)
  if (!relation || relation.getAttribute('TargetMode') === 'External') throw new Error('The first worksheet could not be found.')
  const pathParts = relation.getAttribute('Target').startsWith('/')
    ? []
    : ['xl']
  for (const part of relation.getAttribute('Target').replace(/^\/+/, '').split('/')) {
    if (part === '..') pathParts.pop()
    else if (part && part !== '.') pathParts.push(part)
  }
  const worksheetPath = pathParts.join('/')
  if (!worksheetPath.startsWith('xl/worksheets/')) throw new Error('The first worksheet path is invalid.')

  const sharedStrings = files['xl/sharedStrings.xml']
    ? [...parseXml('xl/sharedStrings.xml').getElementsByTagName('si')]
      .map((item) => [...item.getElementsByTagName('t')].map((text) => text.textContent || '').join(''))
    : []
  const worksheet = parseXml(worksheetPath)
  const rows = [...worksheet.getElementsByTagName('row')]
  if (rows.length > 1001) throw new Error('The first worksheet can contain at most 1,000 employee rows.')
  const columnIndex = (reference) => {
    const letters = reference.match(/^[A-Z]+/i)?.[0]
    if (!letters) return -1
    return [...letters.toUpperCase()].reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0) - 1
  }
  return rows.map((row) => {
    const number = Number(row.getAttribute('r'))
    const cells = []
    for (const cell of row.getElementsByTagName('c')) {
      const index = columnIndex(cell.getAttribute('r') || '')
      if (index < 0 || index > 16383) continue
      const value = cell.getElementsByTagName('v')[0]?.textContent ?? ''
      const type = cell.getAttribute('t')
      let parsed = value
      if (type === 's') parsed = sharedStrings[Number(value)] ?? ''
      else if (type === 'inlineStr') parsed = [...cell.getElementsByTagName('t')].map((text) => text.textContent || '').join('')
      else if (type !== 'str' && value.trim() !== '' && Number.isFinite(Number(value))) parsed = Number(value)
      cells[index] = parsed
    }
    return { number, cells }
  })
}

function ImportExcelPage({ onImported }) {
  const [fileName, setFileName] = useState('')
  const [previewRows, setPreviewRows] = useState([])
  const [fileError, setFileError] = useState('')
  const [importError, setImportError] = useState('')
  const [refreshError, setRefreshError] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const requiredHeaders = ['Employee number', 'Name', 'Department', 'Basic salary', 'Allowances', 'Deductions']

  async function readWorkbook(event) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    setFileName('')
    setPreviewRows([])
    setFileError('')
    setImportError('')
    setRefreshError('')
    setResult(null)
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setFileError('Choose an .xlsx workbook.')
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setFileError('The workbook must be 10 MB or smaller.')
      return
    }
    try {
      const sheetRows = readXlsxRows(await file.arrayBuffer())
      const headerEntry = sheetRows.find((row) => row.cells.some((cell) => String(cell ?? '').trim()))
      if (!headerEntry) throw new Error('The first sheet has no employee rows to preview.')
      const headerNames = headerEntry.cells.map((header) => String(header ?? '').trim().toLowerCase())
      const columnIndexes = requiredHeaders.map((header) => headerNames.indexOf(header.toLowerCase()))
      const missingHeaders = requiredHeaders.filter((_, index) => columnIndexes[index] < 0)
      if (missingHeaders.length) {
        setFileError(`Missing required columns: ${missingHeaders.join(', ')}.`)
        return
      }
      const parsedRows = sheetRows.filter((row) => row.number > headerEntry.number).flatMap(({ number, cells }) => {
        if (cells.every((cell) => String(cell ?? '').trim() === '')) return []
        const cell = (column) => cells[columnIndexes[column]] ?? ''
        const employeeNumber = String(cell(0)).trim().toUpperCase()
        const name = String(cell(1)).trim()
        const department = String(cell(2)).trim()
        const parseAmount = (raw, blankIsZero) => {
          if (raw === '' || raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim())) {
            return blankIsZero ? 0 : null
          }
          const amount = typeof raw === 'number' ? raw : Number(String(raw).trim())
          return Number.isFinite(amount) && amount >= 0 ? Number(amount.toFixed(2)) : null
        }
        const basicSalary = parseAmount(cell(3), false)
        const allowances = parseAmount(cell(4), true)
        const deductions = parseAmount(cell(5), true)
        const errors = []
        if (!employeeNumber) errors.push('Employee number is blank.')
        else if (!/^[A-Z0-9][A-Z0-9-]{1,31}$/.test(employeeNumber)) errors.push('Employee number format is invalid.')
        if (!name) errors.push('Name is blank.')
        if (basicSalary === null) errors.push('Basic salary must be a non-negative number.')
        if (allowances === null) errors.push('Allowances must be a non-negative number.')
        if (deductions === null) errors.push('Deductions must be a non-negative number.')
        return [{
          sheetRow: number,
          employeeNumber,
          name,
          department,
          basicSalary,
          allowances,
          deductions,
          errors,
        }]
      })
      const counts = new Map()
      for (const row of parsedRows) {
        if (row.employeeNumber) counts.set(row.employeeNumber, (counts.get(row.employeeNumber) || 0) + 1)
      }
      for (const row of parsedRows) {
        if (row.employeeNumber && counts.get(row.employeeNumber) > 1) row.errors.push('Employee number appears more than once.')
      }
      setFileName(file.name)
      setPreviewRows(parsedRows)
      if (!parsedRows.length) setFileError('The first sheet has no employee rows to preview.')
    } catch (readError) {
      setFileError(readError instanceof Error ? `Unable to read the workbook: ${readError.message}` : 'Unable to read the workbook.')
    }
  }

  async function confirmImport() {
    setBusy(true)
    setImportError('')
    setRefreshError('')
    try {
      const rows = previewRows.map(({ employeeNumber, name, department, basicSalary, allowances, deductions }) => ({
        employeeNumber, name, department, basicSalary, allowances, deductions,
      }))
      setResult(await api('/api/admin/people/import', {
        method: 'POST',
        body: JSON.stringify({ rows }),
      }))
      try {
        await onImported()
      } catch {
        setRefreshError('Import completed, but the People list could not be refreshed. Reload the page to see the latest records.')
      }
    } catch (requestError) {
      setImportError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  const invalidRows = previewRows.filter((row) => row.errors.length).length
  const validRows = previewRows.length - invalidRows

  return <section className="panel excel-import-panel">
    <div className="panel-heading"><div><span className="panel-kicker">MANAGEMENT</span><h2>Import employees from Excel</h2></div></div>
    <p className="excel-import-help">Upload an .xlsx file. The first worksheet must include Employee number, Name, Department, Basic salary, Allowances, and Deductions. Blank allowances or deductions count as $0.00.</p>
    <label className="excel-file-picker">Excel workbook (.xlsx)<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={readWorkbook} /></label>
    {fileName && <p className="excel-file-name"><FileSpreadsheet size={16} /> {fileName}</p>}
    {fileError && <p className="excel-import-error" role="alert">{fileError}</p>}
    {importError && <p className="excel-import-error" role="alert">{importError}</p>}
    {refreshError && <p className="excel-import-error" role="alert">{refreshError}</p>}
    {result && <div className="excel-import-success" role="status">
      <strong>Import complete.</strong> Added {result.added}; updated {result.updated}. New employees must change their temporary password at first sign-in.
    </div>}
    {result?.temporaryPasswords?.length > 0 && <section className="excel-passwords" aria-label="Temporary passwords">
      <h3>New employee temporary passwords</h3>
      <p>Share these privately. They are shown only once.</p>
      <div className="table-scroll"><table className="people-table"><thead><tr><th>EMPLOYEE NUMBER</th><th>NAME</th><th>TEMPORARY PASSWORD</th></tr></thead>
        <tbody>{result.temporaryPasswords.map((credential) => <tr key={credential.employeeNumber}>
          <td>{credential.employeeNumber}</td><td>{credential.name}</td><td><code>{credential.password}</code></td>
        </tr>)}</tbody></table></div>
    </section>}
    {previewRows.length > 0 && <>
      <div className="excel-preview-heading"><div><h3>Preview</h3><p>{validRows} valid · {invalidRows} with errors</p></div>
        <button className="primary-button" type="button" disabled={busy || invalidRows > 0} onClick={confirmImport}>
          {busy ? 'Importing…' : 'Confirm import'}
        </button>
      </div>
      {invalidRows > 0 && <p className="excel-import-error" role="alert">Fix the errors in the workbook and select it again before importing.</p>}
      <div className="table-scroll excel-preview-table"><table className="people-table">
        <thead><tr><th>ROW</th><th>EMPLOYEE NUMBER</th><th>NAME</th><th>DEPARTMENT</th><th>BASIC SALARY</th><th>ALLOWANCES</th><th>DEDUCTIONS</th><th>STATUS</th></tr></thead>
        <tbody>{previewRows.map((row) => <tr className={row.errors.length ? 'excel-row-error' : ''} key={row.sheetRow}>
          <td>{row.sheetRow}</td><td>{row.employeeNumber || '—'}</td><td>{row.name || '—'}</td><td>{row.department || '—'}</td>
          <td>{row.basicSalary === null ? '—' : money(row.basicSalary)}</td><td>{row.allowances === null ? '—' : money(row.allowances)}</td>
          <td>{row.deductions === null ? '—' : money(row.deductions)}</td>
          <td>{row.errors.length ? row.errors.join(' ') : 'Ready'}</td>
        </tr>)}</tbody>
      </table></div>
      <p className="excel-import-help">Allowances are saved as other allowance. Deductions are included in new and open draft payroll runs; locked payroll remains unchanged. Employees missing from this file are not deleted.</p>
    </>}
  </section>
}

function PersonModal({ person, error, busy, leaveBalanceReadOnly = false, onClose, onSubmit }) {
  const isEditing = Boolean(person?.id)
  const active = person?.active !== false
  const handleClose = useCallback(() => {
    if (!busy) onClose()
  }, [busy, onClose])
  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function onKeyDown(event) {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault()
        handleClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [busy, handleClose])
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) handleClose() }}>
    <section className="person-dialog" role="dialog" aria-modal="true" aria-labelledby="person-title">
      <header className="person-dialog-header">
        <div><span className="panel-kicker">PEOPLE</span><h2 id="person-title">{isEditing ? 'Edit person' : 'Add person'}</h2></div>
        <button type="button" className="modal-close icon-button" onClick={handleClose} aria-label="Close" disabled={busy}><X size={18} /></button>
      </header>
      <form className="person-form" onSubmit={onSubmit} noValidate>
        <div className="person-dialog-body">
          {profileFields.map(([key, label, type]) => <label key={key}>{label}<input name={key} type={type} min={type === 'number' ? '0' : undefined} step={type === 'number' ? '0.01' : undefined} defaultValue={person?.[key] ?? (key === 'leaveBalance' ? 0 : '')} readOnly={key === 'leaveBalance' && leaveBalanceReadOnly} /></label>)}
          <label>Role<select name="role" defaultValue={person?.role || 'employee'}><option value="employee">Employee</option><option value="admin">Admin</option></select></label>
          <label className="rates-checkbox"><input name="nssaExempt" type="checkbox" defaultChecked={person?.nssa_exempt || false} /> NSSA exempt</label>
          {!isEditing && <label>Temporary password<input name="temporaryPassword" type="password" autoComplete="new-password" minLength={8} /></label>}
          {isEditing && <label className="rates-checkbox"><input name="active" type="checkbox" defaultChecked={active} /> Active</label>}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <footer className="person-dialog-footer">
          <button type="button" className="secondary-button" onClick={handleClose} disabled={busy}>Cancel</button>
          <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save person'}</button>
        </footer>
      </form>
    </section>
  </div>
}

function RunPayrollPage({ month, run, busy, activeEmployeeCount, emailReport, onCreate, onChange, onSave, onLock, onUnlock }) {
  const lines = run?.lines || []
  const totals = payrollTotals(lines)
  const invalid = lines.some((line) => payrollInputs.some(([key]) => !Number.isFinite(Number(line.earnings[key])) || Number(line.earnings[key]) < 0)
    || !Number.isFinite(Number(line.earnings.leaveDaysTaken)) || Number(line.earnings.leaveDaysTaken) < 0
    || Number(line.earnings.leaveDaysTaken) > Number(line.leave_balance))
  const negative = lines.some((line) => payrollInputs.some(([key]) => Number(line.earnings[key]) < 0)
    || Number(line.earnings.leaveDaysTaken) < 0)
  const unsaved = lines.some((line) => payrollInputs.some(([key]) => Number(line.earnings[key]) !== Number(line.savedEarnings?.[key]))
    || Number(line.earnings.leaveDaysTaken) !== Number(line.savedEarnings?.leaveDaysTaken || 0))
  const noEmployees = !lines.length

  return <>
    <section className="panel payroll-toolbar"><div><span className="panel-kicker">MONTHLY PAYROLL</span><h2>{dateLabel(`${month}-01`)}</h2>
      {run?.status === 'locked' && <span className="run-status locked">Confirmed{run.locked_by ? ` by ${run.locked_by}` : ''}</span>}
      {!run && <p>Create the month run to begin. Payroll inputs start at zero.</p>}
    </div>
    {!run ? <button type="button" className="primary-button" onClick={onCreate} disabled={busy || activeEmployeeCount === 0}>Create run</button>
      : run.status === 'draft' ? <button type="button" className="primary-button" onClick={onLock} disabled={busy || invalid || unsaved || noEmployees}>Confirm {dateLabel(`${month}-01`, { month: 'long' })}</button>
        : <button type="button" className="secondary-button" onClick={onUnlock} disabled={busy}>Unlock {dateLabel(`${month}-01`, { month: 'long' })}</button>}
    </section>
    {!run && noEmployees && <p className="empty-history">Add employees on People before running payroll.</p>}
    {emailReport?.month === month && <section className="panel email-delivery-report" aria-live="polite">
      <h2>Payslip email results</h2>
      <EmailDeliveryGroup title="Sent" people={emailReport.sent} />
      <EmailDeliveryGroup title="Skipped (no email)" people={emailReport.skippedNoEmail} />
      <EmailDeliveryGroup title="Skipped (deactivated)" people={emailReport.skippedInactive} />
      <EmailDeliveryGroup title="Failed" people={emailReport.failed} showReason />
    </section>}
    {run && <section className="panel payroll-lines-panel">
      {invalid && <div className="notice-error">{negative ? 'Amounts and leave days cannot be negative.' : 'Enter valid amounts and ensure leave taken does not exceed the available balance.'}</div>}
      {unsaved && <div className="payroll-unsaved-note">Save changed lines before locking the month.</div>}
      {!lines.length ? <div className="empty-history">Add employees on People before running payroll.</div> : <div className="table-scroll">
        <table className="run-table"><thead><tr>
          <th>COMPANY NUMBER / NAME</th>{payrollInputs.map(([, label]) => <th key={label}>{label.toUpperCase()} (USD)</th>)}
          <th>LEAVE DAYS TAKEN</th><th>LEAVE BALANCE AFTER</th>
          <th>GROSS</th><th>NSSA EMPLOYEE</th><th>PAYE</th><th>AIDS LEVY</th><th>NET</th>{run.status === 'draft' && <th>ACTION</th>}
        </tr></thead><tbody>{lines.map((line) => <tr key={line.id}>
          <td data-label="Employee"><strong>{line.company_number}</strong><small>{line.full_name}</small></td>
          {payrollInputs.map(([key, label]) => <td data-label={`${label} (USD)`} key={key}>{run.status === 'locked' ? money(line.earnings[key]) : <input type="number" min="0" step="0.01" value={line.earnings[key] ?? 0} aria-label={`${label} for ${line.full_name}`} onChange={(event) => onChange(line.id, key, event.target.value)} />}</td>)}
          <td data-label="Leave days taken">{run.status === 'locked' ? `${Number(line.earnings.leaveDaysTaken || 0).toFixed(2)} days` : <><input type="number" min="0" max={line.leave_balance} step="0.01" value={line.earnings.leaveDaysTaken ?? 0} aria-label={`Leave days taken for ${line.full_name}`} onChange={(event) => onChange(line.id, 'leaveDaysTaken', event.target.value)} /><small>Available: {Number(line.leave_balance).toFixed(2)} days</small></>}</td>
          <td data-label="Leave balance after">{Number(run.status === 'locked' ? line.leave_balance : Math.max(0, Number(line.leave_balance) - Number(line.earnings.leaveDaysTaken || 0))).toFixed(2)} days</td>
          <td data-label="Gross">{money(line.calculation.gross)}</td><td data-label="NSSA employee">{money(line.calculation.nssaEmployee)}</td><td data-label="PAYE">{money(line.calculation.paye)}</td><td data-label="AIDS levy">{money(line.calculation.aidsLevy)}</td><td data-label="Net" className="payroll-net">{money(line.calculation.net)}</td>
          {run.status === 'draft' && <td data-label="Action"><button className="secondary-button row-save" disabled={busy || invalid || (!payrollInputs.some(([key]) => Number(line.earnings[key]) !== Number(line.savedEarnings?.[key])) && Number(line.earnings.leaveDaysTaken) === Number(line.savedEarnings?.leaveDaysTaken || 0))} onClick={() => onSave(line)}>Save</button></td>}
        </tr>)}</tbody></table>
      </div>}
      <div className="run-totals">{[
        ['Headcount', lines.length], ['Gross', money(totals.gross)], ['PAYE', money(totals.paye)], ['AIDS levy', money(totals.aids)],
        ['PAYE + AIDS', money(totals.paye + totals.aids)], ['NSSA employee', money(totals.employeeNssa)],
        ['NSSA employer', money(totals.employerNssa)], ['Net to pay', money(totals.net)],
      ].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    </section>}
    <p className="rates-disclaimer">2026 USD ZIMRA table. Confirm on zimra.co.zw and nssa.org.zw before filing. PAYE and AIDS levy are due by the 10th of the following month.</p>
  </>
}

function EmailDeliveryGroup({ title, people, showReason = false }) {
  return <section className={`email-delivery-group ${people.length ? '' : 'empty'}`}>
    <h3>{title} <span>{people.length}</span></h3>
    {people.length > 0 && <ul>{people.map((person, index) => <li key={`${person.email}-${person.name}-${index}`}>
      <span>{person.name}{person.email && <> · {person.email}</>}</span>
      {showReason && person.reason && <small>{person.reason}</small>}
    </li>)}</ul>}
    {showReason && people.length === 0 && <p>None</p>}
  </section>
}

function ManagementEmployeePage({ companyNumber, month, onBack, onSubmit, busy, error }) {
  const [employee, setEmployee] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [editing, setEditing] = useState(null)

  function openEditor() {
    if (!employee) return
    setEditing({
      ...employee,
      companyNumber: employee.company_number,
      fullName: employee.full_name,
      email: employee.email || '',
      nationalId: employee.national_id || '',
      jobTitle: employee.job_title || '',
      bankName: employee.bank_name || '',
      accountNumber: employee.bank_account || '',
      basic: employee.basic_salary,
      housing: employee.housing_allowance,
      transport: employee.transport_allowance,
      otherAllowance: employee.other_allowances,
      leaveBalance: employee.leave_balance ?? 0,
    })
  }

  useEffect(() => {
    let active = true
    api(`/api/admin/people?search=${encodeURIComponent(companyNumber)}`)
      .then((result) => {
        if (!active) return
        const exactMatch = result.people.find((person) => person.company_number.toUpperCase() === companyNumber)
        setEmployee(exactMatch || null)
      })
      .catch(() => {
        if (active) setLoadError(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [companyNumber])

  return <section className="panel management-employee-panel">
    <div className="management-employee-actions">
      <a className="text-action management-employee-back" href={`/admin/payslips?month=${encodeURIComponent(month)}`} onClick={(event) => {
        event.preventDefault()
        onBack()
      }}>← Back to Payslips</a>
      {!loading && employee && <button type="button" className="secondary-button" onClick={openEditor}>Edit</button>}
    </div>
    {loading ? <div className="loading-inline"><span className="loader" />Loading employee</div>
      : loadError ? <p className="notice-error" role="alert">Unable to load this employee. Try returning to Payslips.</p>
        : !employee ? <p className="management-employee-not-found">Employee not found</p>
          : <dl className="management-employee-details">
            <div><dt>Name</dt><dd>{employee.full_name}</dd></div>
            <div><dt>Company number</dt><dd>{employee.company_number}</dd></div>
            <div><dt>Department</dt><dd>{employee.department || '—'}</dd></div>
            <div><dt>Title</dt><dd>{employee.job_title || '—'}</dd></div>
            <div><dt>Email</dt><dd>{employee.email || '—'}</dd></div>
            <div><dt>Basic</dt><dd>{money(employee.basic_salary)}</dd></div>
            <div><dt>Housing</dt><dd>{money(employee.housing_allowance)}</dd></div>
            <div><dt>Transport</dt><dd>{money(employee.transport_allowance)}</dd></div>
            <div><dt>Active</dt><dd>{employee.active ? 'Yes' : 'No'}</dd></div>
          </dl>}
    {editing && <PersonModal
      person={editing}
      error={error}
      busy={busy}
      leaveBalanceReadOnly
      onClose={() => setEditing(null)}
      onSubmit={(event) => onSubmit(event, (updatedEmployee) => {
        setEmployee(updatedEmployee)
        setEditing(null)
      })}
    />}
  </section>
}

function AdminPayslipsPage({ run, rates, search, onViewEmployee }) {
  if (!run) return <section className="panel"><div className="empty-history">No payroll run exists for this month.</div></section>
  const selectedEmployeeId = new URLSearchParams(search).get('employeeId')
  const sorted = [...run.lines]
    .filter((line) => !selectedEmployeeId || String(line.employee_id) === selectedEmployeeId)
    .sort((a, b) => a.company_number.localeCompare(b.company_number))
  const companyName = run.settings_snapshot?.companyName || rates.companyName
  return <section className="panel print-slip">
    <div className="print-heading"><div><span className="panel-kicker">{companyName || 'PAYROLL'}</span><h2>{dateLabel(run.period_start)} · {run.status === 'locked' ? 'Confirmed' : 'Draft'}</h2></div><button className="secondary-button no-print" onClick={() => window.print()}>Print all</button></div>
    <div className="table-scroll"><table className="payslip-print-table">
      <thead><tr>{['Company name', 'Company number', 'Name', 'Department', 'Title', 'Month', 'Basic', 'Housing', 'Transport', 'Other allowance', 'Overtime', 'Bonus', 'Gross', 'NSSA employee', 'Taxable income', 'PAYE', 'AIDS levy', 'Loan', 'Other deduction', 'Net pay', 'Employer NSSA', 'SDF', 'NEC', 'Cost to company', 'Leave taken', 'Leave balance', 'Management'].map((label) => <th key={label}>{label}</th>)}</tr></thead>
      <tbody>{sorted.map((line) => {
        const calc = line.calculation
        return <tr key={line.id}>
          <td>{companyName || '—'}</td><td>{line.company_number}</td><td>{line.full_name}</td><td>{line.department || '—'}</td><td>{line.job_title || '—'}</td><td>{dateLabel(run.period_start)}</td>
          <td>{money(calc.basic)}</td><td>{money(calc.housing)}</td><td>{money(calc.transport)}</td><td>{money(calc.otherAllowances)}</td><td>{money(calc.overtime)}</td><td>{money(calc.bonus)}</td><td>{money(calc.gross)}</td>
          <td>{money(calc.nssaEmployee)}</td><td>{money(calc.taxableIncome)}</td><td>{money(calc.paye)}</td><td>{money(calc.aidsLevy)}</td><td>{money(calc.loan)}</td><td>{money(calc.otherDeduction)}</td><td className="payroll-net">{money(calc.net)}</td>
          <td>{money(calc.nssaEmployer)}</td><td>{money(calc.sdf)}</td><td>{money(calc.nec)}</td><td>{money(calc.gross + calc.nssaEmployer + calc.sdf + calc.nec)}</td>
          <td>{Number(line.leave_days_taken || 0).toFixed(2)} days</td><td>{Number(line.leave_balance || 0).toFixed(2)} days</td>
          <td><button className="text-action payslip-view-employee no-print" onClick={() => onViewEmployee(line.company_number)}>View employee</button></td>
        </tr>
      })}</tbody>
    </table></div>
    <p className="employer-cost-note">Employer cost (not deducted)</p><footer className="private-footer">Private</footer>
    {run.status !== 'locked' && <p className="rates-disclaimer no-print">Draft figures recalculate from current employee salaries and rates. Confirm the month to save a payslip snapshot.</p>}
  </section>
}

function ReturnsPage({ data, month }) {
  if (!data) return <div className="empty-history">Run payroll for {dateLabel(`${month}-01`)} to view returns.</div>
  const r = data.returns
  const due = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 10))
  return <div className="returns-grid">
    <section className="panel return-block"><span className="panel-kicker">ZIMRA</span><h2>ZIMRA return</h2>
      <ReturnRow label="PAYE" value={r.paye} /><ReturnRow label="AIDS levy" value={r.aidsLevy} /><ReturnRow label="Combined" value={r.paye + r.aidsLevy} strong />
      <p>Pay by {dateLabel(due, { month: 'long', day: 'numeric', year: 'numeric' })}.</p></section>
    <section className="panel return-block"><span className="panel-kicker">NSSA</span><h2>NSSA return</h2>
      <ReturnRow label="Employee" value={r.employeeNssa} /><ReturnRow label="Employer" value={r.employerNssa} /><ReturnRow label="Combined" value={r.employeeNssa + r.employerNssa} strong /><ReturnRow label="Insurable earnings after ceiling" value={r.insurableEarnings} /></section>
    <section className="panel return-block bank-list-block"><span className="panel-kicker">BANK LIST</span><h2>Net pay by employee</h2>
      <div className="table-scroll"><table className="people-table"><thead><tr><th>COMPANY NUMBER</th><th>NAME</th><th>BANK</th><th>ACCOUNT</th><th>NET</th></tr></thead>
        <tbody>{data.bankList.map((item) => <tr key={item.companyNumber}><td>{item.companyNumber}</td><td>{item.name}</td><td>{item.bank || '—'}</td><td>{item.account || '—'}</td><td>{money(item.net)}</td></tr>)}</tbody>
      </table></div>
    </section>
  </div>
}

function ReturnRow({ label, value, strong = false }) {
  return <div className={`return-row ${strong ? 'return-row-strong' : ''}`}><span>{label}</span><strong>{money(value)}</strong></div>
}

function RatesPage({ rates, setRates, onSave, onReset }) {
  const changeBand = (index, key, value) => setRates((current) => ({
    ...current, taxBands: current.taxBands.map((band, i) => i === index ? { ...band, [key]: value === '' ? '' : Number(value) / 100 } : band),
  }))
  const companyFields = [['companyName', 'Company name'], ['companyAddress', 'Address'], ['payeNumber', 'PAYE number'], ['nssaSsr', 'NSSA SSR']]
  const fields = [['nssaEmployeeRate', 'NSSA employee (%)'], ['nssaEmployerRate', 'NSSA employer (%)'], ['nssaCap', 'NSSA ceiling (USD)', false], ['aidsLevyRate', 'AIDS levy (%)'], ['sdfRate', 'SDF (%)'], ['necRate', 'NEC (%)']]
  return <section className="panel rates-panel">
    <div className="panel-heading"><div><span className="panel-kicker">COMPANY AND STATUTORY DEFAULTS</span><h2>Rates</h2></div></div>
    <form onSubmit={onSave} noValidate>
      <div className="rates-grid">{companyFields.map(([key, label]) => <label key={key}>{label}<input value={rates[key] || ''} maxLength={300} onChange={(event) => setRates((current) => ({ ...current, [key]: event.target.value }))} /></label>)}</div>
      <div className="rates-grid rates-grid-spaced">{fields.map(([key, label, percent = true]) => <label key={key}>{label}
        <input type="number" min="0" max={percent ? '100' : undefined} step="0.01" value={percent ? (rates[key] === '' ? '' : (Number(rates[key]) * 100).toFixed(2)) : rates[key]} onChange={(event) => setRates((current) => ({ ...current, [key]: percent ? (event.target.value === '' ? '' : Number(event.target.value) / 100) : (event.target.value === '' ? '' : Number(event.target.value)) }))} />
      </label>)}</div>
      <label className="rates-checkbox"><input type="checkbox" checked={rates.nssaDeductibleBeforePaye} onChange={(event) => setRates((current) => ({ ...current, nssaDeductibleBeforePaye: event.target.checked }))} /> Subtract NSSA before PAYE</label>
      <div className="table-scroll"><table className="rates-table"><thead><tr><th>MONTHLY TAX BAND (USD)</th><th>RATE</th></tr></thead>
        <tbody>{rates.taxBands.map((band, index) => <tr key={index}><td>{band.limit === null ? 'Above previous band' : <input type="number" min="0" step="0.01" value={band.limit} aria-label={`Tax band ${index + 1} limit`} onChange={(event) => setRates((current) => ({ ...current, taxBands: current.taxBands.map((item, i) => i === index ? { ...item, limit: event.target.value === '' ? '' : Number(event.target.value) } : item) }))} />}</td>
          <td><input type="number" min="0" max="100" step="0.01" value={band.rate === '' ? '' : (Number(band.rate) * 100).toFixed(2)} aria-label={`Tax band ${index + 1} rate`} onChange={(event) => changeBand(index, 'rate', event.target.value)} />%</td></tr>)}</tbody></table></div>
      <div className="rates-footer"><button type="button" className="secondary-button" onClick={onReset}>Restore 2026 USD defaults</button><button className="primary-button" type="submit">Save rates</button></div>
    </form>
    <p className="rates-disclaimer">2026 USD ZIMRA table. Confirm on zimra.co.zw and nssa.org.zw before filing. PAYE and AIDS levy are due by the 10th of the following month.</p>
  </section>
}

function MyPayPage({ latest, slips, companyNumber, leaveBalance, onOpen }) {
  const yearSlips = slips.filter((slip) => String(slip.period_start).slice(0, 4) === currentYear)
  const ytdTaxAvailable = yearSlips.every((slip) => slip.statutory_json
    && slip.statutory_json.paye !== undefined && slip.statutory_json.aidsLevy !== undefined)
  const ytdTax = yearSlips.reduce((sum, slip) => sum + Number(slip.statutory_json?.paye || 0) + Number(slip.statutory_json?.aidsLevy || 0), 0)
  return <>
    <section className="pay-overview">
      <div className="latest-net-summary">
        <span className="panel-kicker">LATEST NET PAY · {latest ? dateLabel(latest.period_start) : 'NO PAYSLIP'}</span>
        <strong>{latest ? money(latest.net_pay) : '—'}</strong>
        {latest && <button className="text-action" onClick={() => onOpen(String(latest.period_start).slice(0, 7))}>View payslip</button>}
      </div>
      <div className="pay-overview-figures">
        {[
          ['Gross', latest ? money(latest.gross_pay) : '—'],
          ['Deductions', latest ? money(slipDeductions(latest)) : '—'],
          [`PAYE + AIDS levy · ${currentYear}`, yearSlips.length && ytdTaxAvailable ? money(ytdTax) : '—'],
          ['Slip count', String(yearSlips.length)],
          ['Leave balance', `${Number(leaveBalance || 0).toFixed(2)} days`],
        ].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
      </div>
    </section>
    {latest && <section className="panel latest-slip-panel">
      <div className="panel-heading"><div><span className="panel-kicker">LATEST PAYSLIP</span><h2>{dateLabel(latest.period_start)}</h2></div>
        <button className="text-action" onClick={() => onOpen(String(latest.period_start).slice(0, 7))}>Open payslip</button></div>
      <PayslipBreakdown slip={latest} />
    </section>}
    <section className="panel full-history-panel"><div className="history-toolbar"><div><span className="panel-kicker">YOUR PAY RECORDS</span><h2>Your pay records</h2></div></div>
      <div className="table-scroll"><table className="people-table"><thead><tr><th>MONTH</th><th>BASIC</th><th>HOUSING</th><th>TRANSPORT</th><th>DEDUCTIONS</th><th>NET PAY</th><th>VIEW</th></tr></thead><tbody>{slips.length ? slips.map((slip) => {
        const earnings = slip.earnings_json || {}
        return <tr key={slip.period_start}>
          <td data-label="Month">{dateLabel(slip.period_start)}</td>
          <td data-label="Basic">{displayMoney(earnings.basic)}</td>
          <td data-label="Housing">{displayMoney(earnings.housing)}</td>
          <td data-label="Transport">{displayMoney(earnings.transport)}</td>
          <td data-label="Deductions">{money(slipDeductions(slip))}</td>
          <td data-label="Net pay" className="payroll-net">{money(slip.net_pay)}</td>
          <td data-label="View"><button className="text-action" onClick={() => onOpen(String(slip.period_start).slice(0, 7))}>Open / print</button></td>
        </tr>
      })
        : <tr className="empty-pay-record"><td colSpan="7">No confirmed payslip for {companyNumber || 'your company number'} yet.</td></tr>}</tbody></table></div>
    </section>
  </>
}

function MyDetailsPage({ employee, onSubmit }) {
  const pending = typeof employee.bank_change_note === 'string' ? (() => { try { return JSON.parse(employee.bank_change_note) } catch { return null } })() : employee.bank_change_note
  const fixedMonthlyPay = Number(employee.basic_salary || 0) + Number(employee.housing_allowance || 0)
    + Number(employee.transport_allowance || 0) + Number(employee.other_allowances || 0)
  return <section className="panel details-panel">
    <div className="details-grid">
      <section className="details-block identity-block"><h2>Employee</h2>{[
        ['Name', employee.full_name], ['Company number', employee.company_number],
        ['Department', employee.department], ['Job title', employee.job_title],
      ].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value || '—'}</strong></div>)}</section>
      <section className="details-block"><h2>Pay</h2>{[
        ['Basic', money(employee.basic_salary)], ['Housing', money(employee.housing_allowance)],
        ['Transport', money(employee.transport_allowance)], ['Other allowance', money(employee.other_allowances)],
        ['Leave balance', `${Number(employee.leave_balance || 0).toFixed(2)} days`],
        ['Fixed monthly pay', money(fixedMonthlyPay)],
      ].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</section>
      <section className="details-block bank-block"><h2>Bank</h2>
        <div><span>Paid bank</span><strong>{employee.bank_name || '—'}</strong></div>
        <div><span>Paid account number</span><strong>{employee.bank_account || '—'}</strong></div>
        <form className="bank-request-form" onSubmit={onSubmit}><span className="panel-kicker">REQUEST BANK CHANGE</span>
          <p>Requests do not change paid bank details until payroll accepts them.</p>
          <div className="bank-request-fields">
            <label>Bank<input name="bankName" defaultValue={pending?.bankName || employee.bank_name || ''} required maxLength={200} /></label>
            <label>Account number<input name="accountNumber" defaultValue={pending?.accountNumber || employee.bank_account || ''} required maxLength={200} /></label>
          </div>
          {pending && <div className="bank-request-badge">Bank change requested</div>}
          <button className="primary-button" type="submit">Request bank change</button>
        </form>
      </section>
    </div>
    <p className="employee-summary">Company number and salary details are read-only. <a href="/change-password" onClick={(event) => { event.preventDefault(); go('/change-password') }}>Change password</a></p>
  </section>
}

function PayslipBreakdown({ slip }) {
  const calc = slip.statutory_json || {}
  const earnings = slip.earnings_json || {}
  const rows = [
    ['Basic', calc.basic ?? earnings.basic], ['Housing', calc.housing ?? earnings.housing],
    ['Transport', calc.transport ?? earnings.transport], ['Other allowance', calc.otherAllowances ?? earnings.otherAllowances],
    ['Overtime', calc.overtime ?? earnings.overtime], ['Bonus', calc.bonus ?? earnings.bonus],
    ['Gross', calc.gross ?? slip.gross_pay], ['NSSA employee', calc.nssaEmployee],
    ['Taxable income', calc.taxableIncome], ['PAYE', calc.paye], ['AIDS levy', calc.aidsLevy],
    ['Loan', calc.loan], ['Other deduction', calc.otherDeduction], ['Net pay', calc.net ?? slip.net_pay],
    ['Leave taken', earnings.leaveDaysTaken ?? 0],
    ['Leave balance after', earnings.leaveBalanceAfter ?? null],
  ]
  const employerRows = [['NSSA employer', calc.nssaEmployer], ['SDF', calc.sdf], ['NEC', calc.nec]]
  return <>
    <div className="slip-rows">{rows.map(([label, value]) => <div key={label}><span>{label}</span><strong>{label.startsWith('Leave ')
      ? value === null ? '—' : `${Number(value).toFixed(2)} days`
      : displayMoney(value)}</strong></div>)}</div>
    <section className="employer-cost-block"><h3>Employer cost (not deducted from your pay)</h3>
      <div className="slip-rows">{employerRows.map(([label, value]) => <div key={label}><span>{label}</span><strong>{displayMoney(value)}</strong></div>)}</div>
    </section>
  </>
}

function EmployeePayslipPage({ slip, onBack }) {
  if (!slip) return <section className="panel"><div className="empty-history">That payslip is not available.</div></section>
  const employee = slip.employee_snapshot || {}
  return <section className="panel employee-payslip">
    <div className="print-heading"><div><span className="panel-kicker">{employee.company_name || 'PRIVATE PAYSLIP'}</span><h2>{dateLabel(slip.period_start)}</h2><p>{employee.company_number || employee.employee_number} · {employee.full_name}</p></div><button className="secondary-button no-print" onClick={() => window.print()}>Print</button></div>
    <PayslipBreakdown slip={slip} />
    <footer className="private-footer">Private</footer>
    <button className="text-action no-print" onClick={onBack}>Back to My pay</button>
  </section>
}

export default App
