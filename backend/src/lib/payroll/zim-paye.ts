export const DEFAULT_SETTINGS = {
  companyName: "",
  companyAddress: "",
  payeNumber: "",
  nssaSsr: "",
  taxBands: [
    { limit: 100, rate: 0 },
    { limit: 300, rate: 0.2 },
    { limit: 1000, rate: 0.25 },
    { limit: 2000, rate: 0.3 },
    { limit: 3000, rate: 0.35 },
    { limit: null, rate: 0.4 },
  ],
  aidsLevyRate: 0.03,
  nssaEmployeeRate: 0.045,
  nssaEmployerRate: 0.045,
  nssaCap: 700,
  nssaDeductibleBeforePaye: true,
  sdfRate: 0.005,
  necRate: 0,
};

function roundMoney(value) {
  return Number((value + Number.EPSILON).toFixed(2));
}

export function payeOn(taxableIncome, settings = DEFAULT_SETTINGS) {
  const income = Math.max(0, Number(taxableIncome) || 0);
  let previousLimit = 0;
  let tax = 0;

  for (const band of settings.taxBands) {
    const bandIncome = band.limit === null
      ? Math.max(0, income - previousLimit)
      : Math.max(0, Math.min(income, band.limit) - previousLimit);
    tax += bandIncome * band.rate;
    if (band.limit === null || income <= band.limit) break;
    previousLimit = band.limit;
  }

  return roundMoney(tax);
}

export function calcLine(earnings, settings = DEFAULT_SETTINGS) {
  const amount = (key) => {
    const value = Number(earnings[key] ?? 0);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${key} must be a non-negative number`);
    }
    return roundMoney(value);
  };
  const basic = amount("basic");
  const housing = amount("housing");
  const transport = amount("transport");
  const otherAllowances = amount("otherAllowances");
  const overtime = amount("overtime");
  const bonus = amount("bonus");
  const loan = amount("loan");
  const otherDeduction = amount("otherDeduction");
  const gross = roundMoney(basic + housing + transport + otherAllowances + overtime + bonus);
  const nssaBase = Math.min(settings.nssaCap, basic + housing + transport + otherAllowances);
  const exempt = earnings.nssaExempt === true;
  const nssaEmployee = exempt ? 0 : roundMoney(nssaBase * settings.nssaEmployeeRate);
  const nssaEmployer = exempt ? 0 : roundMoney(nssaBase * settings.nssaEmployerRate);
  const taxableIncome = roundMoney(Math.max(
    0,
    gross - (settings.nssaDeductibleBeforePaye ? nssaEmployee : 0),
  ));
  const paye = payeOn(taxableIncome, settings);
  const aidsLevy = roundMoney(paye * settings.aidsLevyRate);
  const sdf = roundMoney(gross * settings.sdfRate);
  const nec = roundMoney(gross * settings.necRate);
  const net = roundMoney(gross - nssaEmployee - paye - aidsLevy - loan - otherDeduction);

  return {
    basic, housing, transport, otherAllowances, overtime, bonus, loan, otherDeduction,
    gross, nssaBase: roundMoney(nssaBase), nssaEmployee, nssaEmployer,
    taxableIncome, paye, aidsLevy, sdf, nec, net,
  };
}
