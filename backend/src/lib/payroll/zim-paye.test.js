const { test } = require("node:test");
const assert = require("node:assert/strict");
const calculator = import("./zim-paye.ts");

test("calculates the 2026 PAYE at USD 3,000 and 3,100", async () => {
  const { payeOn } = await calculator;
  assert.equal(payeOn(3000), 865);
  assert.equal(payeOn(3100), 905);
});

test("calculates PAYE and AIDS levy on taxable USD 500 without an NSSA deduction", async () => {
  const { calcLine, DEFAULT_SETTINGS } = await calculator;
  const result = calcLine(
    { basic: 500 },
    { ...DEFAULT_SETTINGS, nssaDeductibleBeforePaye: false },
  );
  assert.equal(result.taxableIncome, 500);
  assert.equal(result.paye, 90);
  assert.equal(result.aidsLevy, 2.7);
});

test("deducts employee NSSA before PAYE and excludes overtime and bonus from the NSSA base", async () => {
  const { calcLine } = await calculator;
  const result = calcLine({ basic: 500 });
  assert.deepEqual(
    [result.nssaEmployee, result.taxableIncome, result.paye, result.aidsLevy, result.net],
    [22.5, 477.5, 84.38, 2.53, 390.59],
  );
  const extraPay = calcLine({ basic: 500, overtime: 100, bonus: 50 });
  assert.equal(extraPay.nssaBase, 500);
});

test("caps the NSSA contributory base and applies default employer rates", async () => {
  const { calcLine, DEFAULT_SETTINGS } = await calculator;
  const result = calcLine({ basic: 1000 });
  assert.equal(result.nssaBase, DEFAULT_SETTINGS.nssaCap);
  assert.equal(result.nssaEmployee, 31.5);
  assert.equal(result.nssaEmployer, 31.5);
  assert.equal(result.nec, 0);
});
