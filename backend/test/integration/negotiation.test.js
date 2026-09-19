import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';

let broker;
let senior;
let uw;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });

beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
  senior = await makeUser('senior_broker');
  uw = await makeUser('underwriter');
});

const STRUCTURES = [
  {
    basis: 'NP',
    layers: [
      { name: 'Layer 1', limit: 5_000_000, attachment: 1_000_000, premium: 400_000, rate_pct: 8 },
      { name: 'Layer 2', limit: 10_000_000, attachment: 6_000_000, premium: 250_000 },
    ],
    prop: {},
  },
  {
    basis: 'PROP',
    layers: [],
    prop: { treatyType: 'QS', qsLimit: 4_000_000, commissionPct: 30, epi: 9_000_000 },
  },
];

/** A placement with structures to quote and a built pack, ready to go out. */
async function setup(api, { withPack = true, structures = STRUCTURES } = {}) {
  const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: `Neg ${Math.random()}` } });
  const placement = await api('POST', '/api/placements', {
    token: broker.token,
    body: {
      cedant_id: cedant.body.id, class: 'Property Cat XoL', inception: '2027-01-01',
      expiry: '2027-12-31', currency: 'USD',
    },
  });
  const pid = placement.body.id;
  await api('PATCH', `/api/placements/${pid}`, { token: broker.token, body: { quote_structures: structures } });

  const markets = [];
  for (const name of ['Lead Re', 'Follow Re', 'Third Re']) {
    const m = await api('POST', '/api/markets', { token: broker.token, body: { name: `${name} ${Math.random()}` } });
    markets.push(m.body);
  }
  // A pack goes to market only once a Senior Broker has approved it.
  if (withPack) {
    const pack = await api('POST', `/api/placements/${pid}/packs`, { token: broker.token, body: {} });
    await api('POST', `/api/packs/${pack.body.id}/submit`, { token: broker.token, body: {} });
    const approved = await api('POST', `/api/packs/${pack.body.id}/approve`, { token: senior.token, body: {} });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
  }
  return { pid, markets };
}

test('an unapproved pack does not go to market', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await setup(api, { withPack: false });
    await api('POST', `/api/placements/${pid}/packs`, { token: broker.token, body: {} });
    const res = await api('POST', `/api/placements/${pid}/negotiation/send`, {
      token: broker.token, body: { market_ids: [markets[0].id] },
    });
    assert.equal(res.status, 422);
    assert.match(res.body.error, /approved by a Senior Broker/i);
  });
});

const board = (api, pid, token) => api('GET', `/api/placements/${pid}/negotiation`, { token });

test('before anything is sent, the board shows the structures and no markets', async () => {
  await withServer(async (api) => {
    const { pid } = await setup(api);
    const res = await board(api, pid, broker.token);
    assert.equal(res.status, 200);
    assert.equal(res.body.markets.length, 0);
    assert.equal(res.body.board.length, 2);
    assert.deepEqual(res.body.board[0].lines.map((l) => l.layer_index), [0, 1]);
    assert.equal(res.body.board[1].lines[0].layer_index, null);
    assert.equal(res.body.pack.latest.version, 1);
  });
});

test('the pack goes to market, and those markets appear on the board', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await setup(api);
    const sent = await api('POST', `/api/placements/${pid}/negotiation/send`, {
      token: broker.token,
      body: { market_ids: markets.map((m) => m.id) },
    });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.sent.length, 3);
    assert.equal(sent.body.sent_pack.version, 1);
    // The board comes back with it: every market approached is approached
    // for a lead quote, so every one is a lead, and they read by name.
    assert.ok(sent.body.markets.every((m) => m.role === 'lead'));
    const names = sent.body.markets.map((m) => m.market_name);
    assert.deepEqual(names, [...names].sort());
    assert.ok(sent.body.markets.every((m) => m.status === 'SENT' && m.pack_version === 1),
      'every market holds version 1');
    // The bare send names no underwriter: nobody was emailed.
    assert.ok(sent.body.markets.every((m) => Array.isArray(m.underwriters) && m.underwriters.length === 0));
  });
});

test('sending again to a market already holding the pack changes nothing', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await setup(api);
    await api('POST', `/api/placements/${pid}/negotiation/send`, {
      token: broker.token, body: { market_ids: [markets[0].id] },
    });
    const again = await api('POST', `/api/placements/${pid}/negotiation/send`, {
      token: broker.token, body: { market_ids: [markets[0].id, markets[1].id] },
    });
    assert.equal(again.body.sent.length, 1, 'only the new market is added');
    assert.equal(again.body.markets.length, 2);
  });
});

test('a pack must exist, and there must be something to quote', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await setup(api, { withPack: false });
    const noPack = await api('POST', `/api/placements/${pid}/negotiation/send`, {
      token: broker.token, body: { market_ids: [markets[0].id] },
    });
    assert.equal(noPack.status, 422);
    assert.match(noPack.body.error, /pack/i);

    const { pid: bare, markets: m2 } = await setup(api, { structures: [] });
    const noStructure = await api('POST', `/api/placements/${bare}/negotiation/send`, {
      token: broker.token, body: { market_ids: [m2[0].id] },
    });
    assert.equal(noStructure.status, 422);
    assert.match(noStructure.body.error, /structure/i);
  });
});

test('a quote lands on the line it was given for, and moves the market on', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await setup(api);
    const sent = await api('POST', `/api/placements/${pid}/negotiation/send`, {
      token: broker.token, body: { market_ids: [markets[0].id, markets[1].id] },
    });
    const [lead, follow] = sent.body.markets;

    await api('PUT', `/api/negotiations/${lead.id}/quotes`, {
      token: broker.token,
      body: { structure_index: 1, layer_index: 0, premium: 380_000, rate_pct: 7.6, line_pct: 25, validity: '2027-02-01' },
    });
    await api('PUT', `/api/negotiations/${follow.id}/quotes`, {
      token: broker.token,
      body: { structure_index: 1, layer_index: 0, premium: 410_000, rate_pct: 8.2, line_pct: 15 },
    });
    await api('PUT', `/api/negotiations/${follow.id}/quotes`, {
      token: broker.token, body: { structure_index: 1, layer_index: 1, status: 'declined', notes: 'Outside appetite' },
    });
    // The proportional structure is quoted whole.
    await api('PUT', `/api/negotiations/${lead.id}/quotes`, {
      token: broker.token, body: { structure_index: 2, layer_index: null, commission_pct: 27.5, premium: 8_500_000 },
    });

    const res = await board(api, pid, broker.token);
    const [np, prop] = res.body.board;
    assert.equal(np.lines[0].quotes.length, 2);
    assert.equal(np.lines[0].summary.best_premium, 380_000);
    assert.equal(np.lines[0].summary.line_pct_total, 40);
    assert.equal(np.lines[1].summary.declined, 1);
    assert.equal(prop.lines[0].quotes[0].commission_pct, 27.5);
    assert.equal(res.body.markets.find((m) => m.id === lead.id).status, 'QUOTED');
    assert.equal(res.body.markets.find((m) => m.id === follow.id).status, 'QUOTED');
  });
});

test('a market that declines everything reads as declined', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await setup(api);
    const sent = await api('POST', `/api/placements/${pid}/negotiation/send`, {
      token: broker.token, body: { market_ids: [markets[0].id] },
    });
    const m = sent.body.markets[0];
    for (const layer of [0, 1]) {
      await api('PUT', `/api/negotiations/${m.id}/quotes`, {
        token: broker.token, body: { structure_index: 1, layer_index: layer, status: 'declined' },
      });
    }
    const res = await board(api, pid, broker.token);
    assert.equal(res.body.markets[0].status, 'DECLINED');
  });
});

test('re-quoting one line replaces that quote rather than stacking', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await setup(api);
    const sent = await api('POST', `/api/placements/${pid}/negotiation/send`, {
      token: broker.token, body: { market_ids: [markets[0].id] },
    });
    const m = sent.body.markets[0];
    const first = await api('PUT', `/api/negotiations/${m.id}/quotes`, {
      token: broker.token, body: { structure_index: 1, layer_index: 0, premium: 400_000 },
    });
    const second = await api('PUT', `/api/negotiations/${m.id}/quotes`, {
      token: broker.token, body: { structure_index: 1, layer_index: 0, premium: 360_000, rate_pct: 7.2 },
    });
    assert.equal(first.body.id, second.body.id, 'the same quote, improved');
    const res = await board(api, pid, broker.token);
    assert.equal(res.body.board[0].lines[0].quotes.length, 1);
    assert.equal(res.body.board[0].lines[0].quotes[0].premium, 360_000);

    // And it can be cleared again, putting the market back to SENT.
    const del = await api('DELETE', `/api/negotiations/${m.id}/quotes/${second.body.id}`, { token: broker.token });
    assert.equal(del.status, 204);
    const after = await board(api, pid, broker.token);
    assert.equal(after.body.board[0].lines[0].quotes.length, 0);
    assert.equal(after.body.markets[0].status, 'SENT');
  });
});

test('a quote must name a line the structures actually have', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await setup(api);
    const sent = await api('POST', `/api/placements/${pid}/negotiation/send`, {
      token: broker.token, body: { market_ids: [markets[0].id] },
    });
    const m = sent.body.markets[0];
    const noStructure = await api('PUT', `/api/negotiations/${m.id}/quotes`, {
      token: broker.token, body: { structure_index: 9, layer_index: 0, premium: 1 },
    });
    assert.equal(noStructure.status, 404);
    const noLayer = await api('PUT', `/api/negotiations/${m.id}/quotes`, {
      token: broker.token, body: { structure_index: 1, layer_index: 7, premium: 1 },
    });
    assert.equal(noLayer.status, 404);
    // The proportional structure has no layers to quote.
    const propByLayer = await api('PUT', `/api/negotiations/${m.id}/quotes`, {
      token: broker.token, body: { structure_index: 2, layer_index: 0, premium: 1 },
    });
    assert.equal(propByLayer.status, 404);
  });
});

test('withdrawing a market takes its quotes with it', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await setup(api);
    const sent = await api('POST', `/api/placements/${pid}/negotiation/send`, {
      token: broker.token, body: { market_ids: [markets[0].id, markets[1].id] },
    });
    const m = sent.body.markets[0];
    await api('PUT', `/api/negotiations/${m.id}/quotes`, {
      token: broker.token, body: { structure_index: 1, layer_index: 0, premium: 400_000 },
    });
    assert.equal((await api('DELETE', `/api/negotiations/${m.id}`, { token: broker.token })).status, 204);
    const res = await board(api, pid, broker.token);
    assert.equal(res.body.markets.length, 1);
    assert.equal(res.body.board[0].lines[0].quotes.length, 0);
  });
});

test('a market on the board is a lead market: there is no role to set, only notes and standing', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await setup(api);
    const sent = await api('POST', `/api/placements/${pid}/negotiation/send`, {
      token: broker.token, body: { market_ids: [markets[0].id] },
    });
    assert.equal(sent.body.markets[0].role, 'lead');
    const patched = await api('PATCH', `/api/negotiations/${sent.body.markets[0].id}`, {
      token: broker.token, body: { role: 'follow', notes: 'Spoke to the underwriter' },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.role, 'lead', 'a role sent in is not a choice any more');
    assert.equal(patched.body.notes, 'Spoke to the underwriter');
  });
});

test('reading is open to any signed-in user; driving it is the broker’s', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await setup(api);
    assert.equal((await board(api, pid, uw.token)).status, 200);
    assert.equal((await api('GET', `/api/placements/${pid}/negotiation`)).status, 401);

    const denied = await api('POST', `/api/placements/${pid}/negotiation/send`, {
      token: uw.token, body: { market_ids: [markets[0].id] },
    });
    assert.equal(denied.status, 403);

    const sent = await api('POST', `/api/placements/${pid}/negotiation/send`, {
      token: broker.token, body: { market_ids: [markets[0].id] },
    });
    const quoteDenied = await api('PUT', `/api/negotiations/${sent.body.markets[0].id}/quotes`, {
      token: uw.token, body: { structure_index: 1, layer_index: 0, premium: 1 },
    });
    assert.equal(quoteDenied.status, 403);
  });
});

test('sending the pack is audited', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await setup(api);
    await api('POST', `/api/placements/${pid}/negotiation/send`, {
      token: broker.token, body: { market_ids: [markets[0].id, markets[1].id] },
    });
    const admin = await makeUser('admin');
    const audit = await api('GET', `/api/admin/audit?entity_id=${pid}`, { token: admin.token });
    const entry = audit.body.find((e) => e.action === 'negotiation.send');
    assert.ok(entry, 'the send is on the audit trail');
    assert.equal(entry.detail.markets, 2);
    assert.equal(entry.detail.pack_version, 1);
  });
});

/* ── The quote sheet: pick a market, its structures come through ── */

async function sentTo(api, count = 1) {
  const { pid, markets } = await setup(api);
  const sent = await api('POST', `/api/placements/${pid}/negotiation/send`, {
    token: broker.token, body: { market_ids: markets.slice(0, count).map((m) => m.id) },
  });
  return { pid, markets, negotiations: sent.body.markets };
}

test('a market’s sheet pulls through every structure it was sent', async () => {
  await withServer(async (api) => {
    const { negotiations } = await sentTo(api);
    const res = await api('GET', `/api/negotiations/${negotiations[0].id}/sheet`, { token: broker.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.currency, 'USD');
    assert.equal(res.body.structures.length, 2);
    const [np, prop] = res.body.structures;
    assert.equal(np.source, 'sent');
    assert.equal(np.index, 1);
    assert.deepEqual(np.lines.map((l) => l.layer_index), [0, 1]);
    assert.equal(np.lines[0].label, 'Layer 1');
    assert.equal(np.lines[0].quote, null, 'nothing said yet');
    assert.equal(np.declined, false);
    assert.equal(prop.lines[0].layer_index, null);
    assert.equal(prop.lines[0].asked.commission_pct, 30);
  });
});

test('the sheet saves every structure at once, and comes back filled in', async () => {
  await withServer(async (api) => {
    const { negotiations } = await sentTo(api);
    const saved = await api('PUT', `/api/negotiations/${negotiations[0].id}/sheet`, {
      token: broker.token,
      body: {
        structures: [
          { structure_index: 1, lines: [
            { layer_index: 0, premium: 372_000, rate_pct: 7.44, line_pct: 30, validity: '2027-02-15' },
            { layer_index: 1, premium: 238_000, line_pct: 25 },
          ] },
          { structure_index: 2, lines: [{ layer_index: null, commission_pct: 32.5, premium: 8_600_000 }] },
        ],
      },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.written, 3);
    const [np, prop] = saved.body.structures;
    assert.equal(np.lines[0].quote.premium, 372_000);
    assert.equal(np.lines[0].quote.status, 'quoted');
    assert.equal(np.lines[1].quote.premium, 238_000);
    assert.equal(prop.lines[0].quote.commission_pct, 32.5);
    assert.equal(saved.body.negotiation.status, 'QUOTED');
  });
});

test('ticking declined answers every line of that structure with a decline', async () => {
  await withServer(async (api) => {
    const { pid, negotiations } = await sentTo(api);
    const saved = await api('PUT', `/api/negotiations/${negotiations[0].id}/sheet`, {
      token: broker.token,
      body: {
        structures: [
          { structure_index: 1, declined: true, lines: [{ layer_index: 0, notes: 'Outside appetite' }] },
          { structure_index: 2, lines: [{ layer_index: null, commission_pct: 30 }] },
        ],
      },
    });
    const [np] = saved.body.structures;
    assert.equal(np.declined, true, 'the structure reads as declined');
    assert.ok(np.lines.every((l) => l.quote.status === 'declined'), 'every line, not just the one given');
    assert.equal(np.lines[0].quote.notes, 'Outside appetite');
    assert.equal(np.lines[0].quote.premium, null, 'a decline carries no figures');

    // The board shows the same declines cell by cell.
    const res = await board(api, pid, broker.token);
    assert.equal(res.body.board[0].lines[0].summary.declined, 1);
    assert.equal(res.body.markets[0].status, 'QUOTED', 'it still quoted the other structure');
  });
});

test('a line left blank on the sheet clears what was there', async () => {
  await withServer(async (api) => {
    const { negotiations } = await sentTo(api);
    const id = negotiations[0].id;
    await api('PUT', `/api/negotiations/${id}/sheet`, {
      token: broker.token,
      body: { structures: [{ structure_index: 1, lines: [{ layer_index: 0, premium: 372_000 }] }] },
    });
    const cleared = await api('PUT', `/api/negotiations/${id}/sheet`, {
      token: broker.token,
      body: { structures: [{ structure_index: 1, lines: [{ layer_index: 0 }] }] },
    });
    assert.equal(cleared.body.written, 0);
    assert.equal(cleared.body.cleared, 2, 'both layers of the structure are empty');
    assert.equal(cleared.body.structures[0].lines[0].quote, null);
    assert.equal(cleared.body.negotiation.status, 'SENT', 'back to awaiting an answer');
  });
});

test('a market can answer with a structure of its own', async () => {
  await withServer(async (api) => {
    const { pid, negotiations } = await sentTo(api);
    const saved = await api('PUT', `/api/negotiations/${negotiations[0].id}/sheet`, {
      token: broker.token,
      body: {
        structures: [
          { structure_index: 1, declined: true },
          {
            market_structure: {
              label: 'Lead’s own tower', basis: 'NP',
              structure: { layers: [
                { name: 'Layer 1', limit: 4_000_000, attachment: 2_000_000 },
                { name: 'Layer 2', limit: 14_000_000, attachment: 6_000_000 },
              ] },
              notes: 'Higher attachment, wider top',
            },
            lines: [
              { layer_index: 0, premium: 300_000, rate_pct: 7.5, line_pct: 40 },
              { layer_index: 1, premium: 260_000, line_pct: 40 },
            ],
          },
        ],
      },
    });
    assert.equal(saved.status, 200);
    const own = saved.body.structures.find((s) => s.source === 'market');
    assert.ok(own, 'it comes back on the sheet');
    assert.equal(own.label, 'Lead’s own tower');
    assert.equal(own.lines.length, 2);
    assert.equal(own.lines[0].quote.premium, 300_000);
    assert.equal(own.lines[0].attachment, 2_000_000, 'its own layer, not ours');

    // And it is on the board beside the structures that went out.
    const res = await board(api, pid, broker.token);
    assert.equal(res.body.board.length, 3);
    const boardOwn = res.body.board.find((s) => s.source === 'market');
    assert.equal(boardOwn.market_name, res.body.markets[0].market_name);
    assert.equal(boardOwn.lines[0].summary.best_premium, 300_000);
  });
});

test('a market’s own structure is edited in place, not duplicated', async () => {
  await withServer(async (api) => {
    const { negotiations } = await sentTo(api);
    const id = negotiations[0].id;
    const first = await api('PUT', `/api/negotiations/${id}/sheet`, {
      token: broker.token,
      body: { structures: [{
        market_structure: { label: 'Alternative', basis: 'PROP', structure: { prop: { treatyType: 'QS', qsLimit: 5_000_000 } } },
        lines: [{ layer_index: null, commission_pct: 35 }],
      }] },
    });
    const own = first.body.structures.find((s) => s.source === 'market');
    const second = await api('PUT', `/api/negotiations/${id}/sheet`, {
      token: broker.token,
      body: { structures: [{
        market_structure: { id: own.id, label: 'Alternative (revised)', basis: 'PROP', structure: { prop: { treatyType: 'QS', qsLimit: 6_000_000 } } },
        lines: [{ layer_index: null, commission_pct: 37.5 }],
      }] },
    });
    const structures = second.body.structures.filter((s) => s.source === 'market');
    assert.equal(structures.length, 1, 'the same structure, revised');
    assert.equal(structures[0].label, 'Alternative (revised)');
    assert.equal(structures[0].lines[0].quote.commission_pct, 37.5);
    assert.equal(structures[0].lines[0].capacity, 6_000_000);

    // It can be dropped, taking its quotes with it.
    const del = await api('DELETE', `/api/negotiations/${id}/structures/${own.id}`, { token: broker.token });
    assert.equal(del.status, 204);
    const after = await api('GET', `/api/negotiations/${id}/sheet`, { token: broker.token });
    assert.equal(after.body.structures.filter((s) => s.source === 'market').length, 0);
  });
});

test('a structure with nothing to price is refused', async () => {
  await withServer(async (api) => {
    const { negotiations } = await sentTo(api);
    const res = await api('PUT', `/api/negotiations/${negotiations[0].id}/sheet`, {
      token: broker.token,
      body: { structures: [{ market_structure: { label: 'Empty', basis: 'NP', structure: { layers: [] } } }] },
    });
    assert.equal(res.status, 422);
    assert.match(res.body.error, /no layers or terms/i);
  });
});

test('the sheet only takes lines the structures actually have', async () => {
  await withServer(async (api) => {
    const { negotiations } = await sentTo(api);
    const res = await api('PUT', `/api/negotiations/${negotiations[0].id}/sheet`, {
      token: broker.token, body: { structures: [{ structure_index: 9, lines: [{ layer_index: 0, premium: 1 }] }] },
    });
    assert.equal(res.status, 404);
    // A layer the structure does not have is simply not written.
    const stray = await api('PUT', `/api/negotiations/${negotiations[0].id}/sheet`, {
      token: broker.token, body: { structures: [{ structure_index: 1, lines: [{ layer_index: 7, premium: 1 }] }] },
    });
    assert.equal(stray.status, 200);
    assert.equal(stray.body.written, 0);
  });
});

test('one market’s sheet never touches another’s', async () => {
  await withServer(async (api) => {
    const { negotiations } = await sentTo(api, 2);
    const [first, second] = negotiations;
    await api('PUT', `/api/negotiations/${first.id}/sheet`, {
      token: broker.token, body: { structures: [{ structure_index: 1, lines: [{ layer_index: 0, premium: 300_000 }] }] },
    });
    await api('PUT', `/api/negotiations/${second.id}/sheet`, {
      token: broker.token, body: { structures: [{ structure_index: 1, declined: true }] },
    });
    const a = await api('GET', `/api/negotiations/${first.id}/sheet`, { token: broker.token });
    const b = await api('GET', `/api/negotiations/${second.id}/sheet`, { token: broker.token });
    assert.equal(a.body.structures[0].lines[0].quote.premium, 300_000);
    assert.equal(b.body.structures[0].lines[0].quote.status, 'declined');
    assert.equal(a.body.structures[0].declined, false);
    assert.equal(b.body.structures[0].declined, true);
  });
});

test('saving a sheet is the broker’s; anyone signed in can read one', async () => {
  await withServer(async (api) => {
    const { negotiations } = await sentTo(api);
    assert.equal((await api('GET', `/api/negotiations/${negotiations[0].id}/sheet`, { token: uw.token })).status, 200);
    const denied = await api('PUT', `/api/negotiations/${negotiations[0].id}/sheet`, {
      token: uw.token, body: { structures: [{ structure_index: 1, declined: true }] },
    });
    assert.equal(denied.status, 403);
  });
});

/* ------------------------------------------- quoting the whole layer, not the price */

/** Send the pack to one market and hand back its negotiation id. */
async function sendToLead(api, pid, markets) {
  await api('POST', `/api/placements/${pid}/negotiation/send`, {
    token: broker.token,
    body: { market_ids: [markets[0].id] },
  });
  const res = await board(api, pid, broker.token);
  return res.body.markets[0].id;
}

test('a line carries every column of the layer it was sent as', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await setup(api, {
      structures: [{
        basis: 'NP',
        layers: [{
          name: 'Layer 1', type: 'XoL', limit: 5_000_000, attachment: 1_000_000,
          premium: 400_000, rate_pct: 8, reinstatements: '2', reinstatement_pct: 100,
          egnpi: 20_000_000, aad: 250_000, order_pct: 90, risk_cover: true, cat_cover: false,
        }],
        prop: {},
      }],
    });
    await sendToLead(api, pid, markets);

    const res = await board(api, pid, broker.token);
    const terms = res.body.board[0].lines[0].terms;
    assert.equal(terms.layer_name, 'Layer 1');
    assert.equal(terms.layer_type, 'XoL');
    assert.equal(terms.limit_amt, 5_000_000);
    assert.equal(terms.reinstatements, '2');
    assert.equal(terms.reinstatement_pct, 100);
    assert.equal(terms.egnpi, 20_000_000);
    assert.equal(terms.aad, 250_000);
    assert.equal(terms.order_pct, 90);
    assert.equal(terms.risk_cover, true);
    assert.equal(terms.cat_cover, false, 'a layer excluded from CAT must stay excluded');
  });
});

test('a quote records the underwriter and every term it moved', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await setup(api);
    const negotiationId = await sendToLead(api, pid, markets);

    const contact = await api('POST', `/api/markets/${markets[0].id}/contacts`, {
      token: broker.token,
      body: { name: 'A. Underwriter', email: 'au@lead.test', role: 'Treaty underwriter' },
    });
    assert.equal(contact.status, 201);

    // Sent as 8% with no reinstatements or AAD; quoted harder on all three.
    const saved = await api('PUT', `/api/negotiations/${negotiationId}/quotes`, {
      token: broker.token,
      body: {
        structure_index: 1, layer_index: 0, status: 'quoted',
        contact_id: contact.body.id,
        rate_pct: 9.5, premium: 475_000, aad: 100_000, reinstatements: '1',
        reinstatement_pct: 100, cat_cover: false, line_pct: 25,
      },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.contact_id, contact.body.id);

    const res = await board(api, pid, broker.token);
    const quote = res.body.board[0].lines[0].quotes[0];
    assert.equal(quote.contact_id, contact.body.id);
    assert.equal(Number(quote.rate_pct), 9.5);

    const moved = Object.fromEntries(quote.variance.map((v) => [v.field, v]));
    assert.deepEqual(
      Object.keys(moved).sort(),
      ['aad', 'cat_cover', 'premium', 'rate_pct', 'reinstatement_pct', 'reinstatements'].sort(),
    );
    assert.equal(moved.rate_pct.from, 8);
    assert.equal(moved.rate_pct.to, 9.5);
    assert.equal(moved.cat_cover.from, true);
    assert.equal(moved.cat_cover.to, false);

    // Untouched columns are carried, not blanked, and read as unchanged.
    assert.equal(Number(quote.terms.limit_amt), 5_000_000);
    assert.equal(quote.terms.layer_name, 'Layer 1');
    // ROL follows the quoted premium over the quoted limit.
    assert.equal(Number(quote.rol_pct), 9.5);
  });
});

test('accepting a layer as sent records a quote with nothing moved', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await setup(api);
    const negotiationId = await sendToLead(api, pid, markets);

    await api('PUT', `/api/negotiations/${negotiationId}/quotes`, {
      token: broker.token,
      body: {
        structure_index: 1, layer_index: 0, status: 'quoted',
        layer_name: 'Layer 1', limit_amt: 5_000_000, attachment: 1_000_000,
        premium: 400_000, rate_pct: 8, line_pct: 30,
      },
    });

    const res = await board(api, pid, broker.token);
    const quote = res.body.board[0].lines[0].quotes[0];
    assert.deepEqual(quote.variance, [], 'a layer taken as sent has moved nothing');
    assert.equal(Number(quote.line_pct), 30);
  });
});

// The whole point of snapshotting: the broker reworks the structure after a
// quote is in, and the quote must still say what the underwriter answered.
test('reworking the structure does not rewrite what a quote was answering', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await setup(api);
    const negotiationId = await sendToLead(api, pid, markets);

    await api('PUT', `/api/negotiations/${negotiationId}/quotes`, {
      token: broker.token,
      body: { structure_index: 1, layer_index: 0, status: 'quoted', rate_pct: 9.5, premium: 475_000 },
    });

    // The broker moves the layer under the quote that already came in.
    await api('PATCH', `/api/placements/${pid}`, {
      token: broker.token,
      body: {
        quote_structures: [
          {
            basis: 'NP',
            layers: [
              { name: 'Layer 1', limit: 7_500_000, attachment: 1_000_000, premium: 600_000, rate_pct: 12 },
              { name: 'Layer 2', limit: 10_000_000, attachment: 6_000_000, premium: 250_000 },
            ],
            prop: {},
          },
          STRUCTURES[1],
        ],
      },
    });

    const res = await board(api, pid, broker.token);
    const quote = res.body.board[0].lines[0].quotes[0];
    const rate = quote.variance.find((v) => v.field === 'rate_pct');
    assert.equal(rate.from, 8, 'the comparison must stay against the terms that were quoted on');
    assert.equal(rate.to, 9.5);
    assert.equal(Number(quote.original.limit_amt), 5_000_000);
  });
});

test('a line the underwriter would not quote records no terms', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await setup(api);
    const negotiationId = await sendToLead(api, pid, markets);

    const res = await api('PUT', `/api/negotiations/${negotiationId}/quotes`, {
      token: broker.token,
      body: {
        structure_index: 1, layer_index: 0, status: 'declined',
        rate_pct: 9.5, aad: 100_000, notes: 'Outside appetite',
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'declined');
    assert.equal(res.body.rate_pct, null);
    assert.equal(res.body.aad, null, 'a declined line holds no terms');
    assert.equal(res.body.notes, 'Outside appetite');

    const after = await board(api, pid, broker.token);
    assert.deepEqual(after.body.board[0].lines[0].quotes[0].variance, []);
  });
});

test('the sheet quotes every column, and an alternative structure alongside', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await setup(api);
    const negotiationId = await sendToLead(api, pid, markets);

    const contact = await api('POST', `/api/markets/${markets[0].id}/contacts`, {
      token: broker.token, body: { name: 'B. Underwriter', email: 'bu@lead.test' },
    });

    const res = await api('PUT', `/api/negotiations/${negotiationId}/sheet`, {
      token: broker.token,
      body: {
        structures: [
          {
            structure_index: 1,
            lines: [
              {
                layer_index: 0, contact_id: contact.body.id,
                rate_pct: 9, premium: 450_000, aad: 50_000, reinstatements: '1', line_pct: 20,
              },
              { layer_index: 1, contact_id: contact.body.id, premium: 260_000, line_pct: 15 },
            ],
          },
          {
            market_structure: {
              label: 'Alternative to Structure 1',
              basis: 'NP',
              structure: {
                layers: [{
                  name: 'Layer 1', type: 'XoL', limit: 4_000_000, attachment: 2_000_000,
                  premium: 380_000, rate_pct: 9.5, reinstatements: '2', aad: 100_000,
                }],
              },
            },
            lines: [{ layer_index: 0, contact_id: contact.body.id, premium: 380_000, rate_pct: 9.5, line_pct: 100 }],
          },
        ],
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.written, 3);

    const sheet = await api('GET', `/api/negotiations/${negotiationId}/sheet`, { token: broker.token });
    const sent = sheet.body.structures.find((s) => s.source === 'sent' && s.index === 1);
    assert.equal(Number(sent.lines[0].quote.aad), 50_000);
    assert.equal(sent.lines[0].quote.contact_id, contact.body.id);
    assert.ok(sent.lines[0].quote.variance.some((v) => v.field === 'aad'));

    // The market's own structure is its own baseline — nothing to have moved.
    const own = sheet.body.structures.find((s) => s.source === 'market');
    assert.equal(own.label, 'Alternative to Structure 1');
    assert.equal(Number(own.lines[0].terms.limit_amt), 4_000_000);
    assert.deepEqual(own.lines[0].quote.variance, []);

    // Both stand side by side on the board.
    const after = await board(api, pid, broker.token);
    assert.equal(after.body.board.filter((s) => s.source === 'market').length, 1);
    assert.equal(after.body.markets[0].status, 'QUOTED');
  });
});

test('a structure the underwriter passed on is declined line by line', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await setup(api);
    const negotiationId = await sendToLead(api, pid, markets);

    await api('PUT', `/api/negotiations/${negotiationId}/sheet`, {
      token: broker.token,
      body: {
        structures: [{
          structure_index: 1, declined: true,
          lines: [
            { layer_index: 0, notes: 'No appetite at this attachment' },
            { layer_index: 1, rate_pct: 5 },
          ],
        }],
      },
    });

    const sheet = await api('GET', `/api/negotiations/${negotiationId}/sheet`, { token: broker.token });
    const sent = sheet.body.structures.find((s) => s.index === 1);
    assert.equal(sent.declined, true, 'the whole structure reads as not quoted');
    assert.ok(sent.lines.every((l) => l.quote.status === 'declined'));
    assert.equal(sent.lines[1].quote.rate_pct, null, 'a rate typed then declined is not kept');
  });
});

/* ------------------------------------------------- lead quote or indication */

test('a quote is a lead quote unless captured as an indication, and the kind is read everywhere', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await setup(api);
    const nid = await sendToLead(api, pid, markets);
    const put = (body) => api('PUT', `/api/negotiations/${nid}/quotes`, { token: broker.token, body });

    const lead = await put({ structure_index: 1, layer_index: 0, premium: 432_000, line_pct: 25 });
    assert.equal(lead.status, 200, JSON.stringify(lead.body));
    assert.equal(lead.body.kind, 'lead', 'unsaid, a quote is a lead quote');
    const ind = await put({ structure_index: 1, layer_index: 1, premium: 270_000, line_pct: 25, kind: 'indicative' });
    assert.equal(ind.body.kind, 'indicative');
    assert.equal((await put({ structure_index: 1, layer_index: 1, premium: 1, kind: 'firm' })).status, 422);

    let res = await board(api, pid, broker.token);
    const np = res.body.board[0];
    assert.equal(np.lines[0].quotes[0].kind, 'lead');
    assert.equal(np.lines[1].quotes[0].kind, 'indicative');
    assert.equal(np.lines[1].summary.indicative, 1);
    assert.equal(np.lines[1].summary.quoted, 1);
    assert.equal(res.body.by_underwriter[0].structures[0].kind, 'lead', 'one lead line, one indication: the structure reads as lead');
    assert.equal(res.body.combined[0].by_market[0].layers[1].kind, 'indicative');
    assert.equal(res.body.rol_comparison[0].rows[1].cells[nid].kind, 'indicative');

    // A re-quote that says nothing about the kind keeps it; said again, it moves.
    await put({ structure_index: 1, layer_index: 1, premium: 280_000, line_pct: 20 });
    res = await board(api, pid, broker.token);
    assert.equal(res.body.board[0].lines[1].quotes[0].kind, 'indicative');
    assert.equal(Number(res.body.board[0].lines[1].quotes[0].premium), 280_000);
    await put({ structure_index: 1, layer_index: 1, premium: 280_000, line_pct: 20, kind: 'lead' });
    res = await board(api, pid, broker.token);
    assert.equal(res.body.board[0].lines[1].quotes[0].kind, 'lead');
  });
});

test('the kind is switched per structure, on every line the market priced', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await setup(api);
    const nid = await sendToLead(api, pid, markets);
    const put = (body) => api('PUT', `/api/negotiations/${nid}/quotes`, { token: broker.token, body });
    const kind = (body, token = broker.token) => api('PUT', `/api/negotiations/${nid}/quote-kind`, { token, body });

    // Nothing priced yet: nothing to mark.
    assert.equal((await kind({ structure_index: 1, kind: 'indicative' })).status, 409);

    await put({ structure_index: 1, layer_index: 0, premium: 432_000 });
    await put({ structure_index: 1, layer_index: 1, status: 'declined', notes: 'Aggregate full' });
    await put({ structure_index: 2, layer_index: null, commission_pct: 27.5 });

    const marked = await kind({ structure_index: 1, kind: 'indicative' });
    assert.equal(marked.status, 200, JSON.stringify(marked.body));
    assert.deepEqual(marked.body, { kind: 'indicative', lines: 1 }, 'the priced line moves; the decline has no kind');

    let res = await board(api, pid, broker.token);
    assert.equal(res.body.board[0].lines[0].quotes[0].kind, 'indicative');
    assert.equal(res.body.board[0].lines[1].quotes[0].status, 'declined');
    assert.equal(res.body.board[1].lines[0].quotes[0].kind, 'lead', 'the other structure is untouched');
    assert.equal(res.body.by_underwriter[0].structures[0].kind, 'indicative');
    assert.equal(res.body.by_underwriter[0].structures[1].kind, 'lead');
    assert.equal(res.body.markets[0].status, 'QUOTED', 'an indication is still an answer');

    // The sheet reads it back per structure, and saves it per structure.
    const sheet = await api('GET', `/api/negotiations/${nid}/sheet`, { token: broker.token });
    assert.equal(sheet.body.structures[0].indicative, true);
    assert.equal(sheet.body.structures[1].indicative, false);
    const saved = await api('PUT', `/api/negotiations/${nid}/sheet`, {
      token: broker.token,
      body: {
        structures: [
          { structure_index: 1, indicative: false, lines: [{ layer_index: 0, premium: 432_000 }, { layer_index: 1, status: 'declined', notes: 'Aggregate full' }] },
          { structure_index: 2, indicative: true, lines: [{ layer_index: null, commission_pct: 27.5 }] },
          // A structure of the market's own is switched the same way, by its id.
          {
            market_structure: { label: 'Own tower', basis: 'NP', structure: { layers: [{ name: 'Own 1', limit: 4_000_000, attachment: 2_000_000, premium: 300_000 }] } },
            lines: [{ layer_index: 0, premium: 300_000, line_pct: 40 }],
          },
        ],
      },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.structures[0].indicative, false);
    assert.equal(saved.body.structures[1].indicative, true);
    const own = saved.body.structures.find((s) => s.source === 'market');
    assert.equal(own.indicative, false);
    res = await board(api, pid, broker.token);
    assert.equal(res.body.board[0].lines[0].quotes[0].kind, 'lead');
    assert.equal(res.body.board[1].lines[0].quotes[0].kind, 'indicative');

    const ownMarked = await kind({ market_structure_id: own.id, kind: 'indicative' });
    assert.equal(ownMarked.status, 200, JSON.stringify(ownMarked.body));
    assert.equal(ownMarked.body.lines, 1);
    res = await board(api, pid, broker.token);
    assert.equal(res.body.board.find((s) => s.source === 'market').lines[0].quotes[0].kind, 'indicative');

    // Either structure is named, never both; and it is the broker's to switch.
    assert.equal((await kind({ kind: 'lead' })).status, 422);
    assert.equal((await kind({ structure_index: 1, market_structure_id: own.id, kind: 'lead' })).status, 422);
    assert.equal((await kind({ structure_index: 1, kind: 'lead' }, uw.token)).status, 403);
  });
});
