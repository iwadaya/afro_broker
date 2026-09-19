import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, selectTreaties } from '../../../frontend/src/views/servicing/model.js';
const rows = [
 {reference:'A',cedant_name:'Alpha',class:'XL',country:'ZA',inception:'2025-01-01',currency:'USD',reported_count:2,reported_amount:100,pla_count:1,pla_amount:50,premiums:[{currency:'USD',paid:'100.15',due:'200',upcoming:400,accounts_due:2,layers:1,scheduled_layers:1}]},
 {reference:'B',cedant_name:'Beta',class:'XL',country:'KE',inception:'2026-01-01',currency:'EUR',reported_count:3,reported_amount:200,pla_count:2,pla_amount:100,premiums:[{currency:'EUR',paid:300,due:400,upcoming:500,accounts_due:3,layers:1,scheduled_layers:1}]},
];
test('currency totals never mix and currency-scoped counts follow the money',()=>{
 assert.deepEqual(summarize(rows).paid,{USD:100.15,EUR:300});
 const usd=summarize(rows,'USD');assert.equal(usd.reported_count,2);assert.equal(usd.accounts_due,2);assert.deepEqual(usd.due,{USD:200});
});
test('combined search, year and currency filters share one scope',()=>{
 assert.equal(selectTreaties(rows,{search:'alpha',year:'2025',currency:'USD'}).length,1);
 assert.equal(selectTreaties(rows,{search:'alpha',currency:'EUR'}).length,0);
 assert.equal(selectTreaties(rows,{search:'KE'}).length,1);
 assert.equal(summarize([]).reported_count,0);
});
