/* 装配与决策落地集成回归：node --test tests/ */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runChecks } = require('../scripts/verify-decisions.js');

for (const r of runChecks()) {
  test(r.name, () => assert.equal(r.ok, true, r.detail));
}
