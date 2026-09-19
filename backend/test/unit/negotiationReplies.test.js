// Reading an underwriter's reply without ChatGPT, and matching an inbox
// message to the underwriter it answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heuristicRead, matchInbound } from '../../src/modules/negotiation/replies.js';
import { bodyText } from '../../src/integrations/outlook.js';

test('the keyword read tells a quote, a decline, a question and an acknowledgement apart', () => {
  const quote = heuristicRead('Dear Jo,\n\nThank you for the pack. We are pleased to offer a line of 15% on Layer 1 at a rate on line of 7.5%, premium 375,000, subject to no losses. Valid until 15 December 2026.\n\nRegards');
  assert.equal(quote.kind, 'quote');
  assert.equal(quote.terms.length, 1);
  assert.equal(quote.terms[0].rate_pct, 7.5);
  assert.equal(quote.terms[0].line_pct, 15);
  assert.equal(quote.terms[0].premium, 375000);
  assert.match(quote.deadline, /15 December 2026/i);
  assert.match(quote.summary, /pleased to offer/i);

  assert.equal(heuristicRead('Thanks for sending this over. Unfortunately we are unable to support this programme this year.').kind, 'decline');
  const q = heuristicRead('Could you confirm the as-at date of the loss run? Also, please send the 2025 large loss listing.');
  assert.equal(q.kind, 'question');
  assert.equal(q.questions.length, 1);
  assert.equal(heuristicRead('Received with thanks, we will revert with terms next week.').kind, 'acknowledgement');
  assert.equal(heuristicRead('See you at the conference.').kind, 'other');
});

const CANDIDATES = [
  { recipient_id: 'r1', submission_id: 's1', placement_id: 'p1', market_id: 'm1', email: 'jo@alpha.test', conversation_id: 'conv-1', reference_tag: 'BIQ-AAAA1111', sent_at: '2026-09-02' },
  { recipient_id: 'r2', submission_id: 's1', placement_id: 'p1', market_id: 'm2', email: 'anders@beta.test', conversation_id: 'conv-2', reference_tag: 'BIQ-AAAA1111', sent_at: '2026-09-02' },
  { recipient_id: 'r3', submission_id: 's0', placement_id: 'p1', market_id: 'm1', email: 'jo@alpha.test', conversation_id: 'conv-0', reference_tag: 'BIQ-00000000', sent_at: '2026-08-01' },
];

test('an inbox message is matched by conversation, then by tag and sender, then by sender', () => {
  const byConv = matchInbound({ from: { email: 'someone-else@alpha.test' }, subject: 'Re: anything', conversationId: 'conv-2' }, CANDIDATES);
  assert.equal(byConv.candidate.recipient_id, 'r2');
  assert.equal(byConv.how, 'conversation');

  const byTag = matchInbound({ from: { email: 'jo@alpha.test' }, subject: 'RE: Cedant — renewal pack v1 [BIQ-AAAA1111]', conversationId: 'unknown' }, CANDIDATES);
  assert.equal(byTag.candidate.recipient_id, 'r1', 'the tag picks the submission, the sender the underwriter');
  assert.equal(byTag.how, 'tag+sender');

  const tagOnly = matchInbound({ from: { email: 'assistant@alpha.test' }, subject: 'FW: [BIQ-AAAA1111]' }, CANDIDATES);
  assert.equal(tagOnly.candidate.submission_id, 's1');
  assert.equal(tagOnly.candidate.recipient_id, null, 'an unknown sender on a tagged thread is kept on the submission, not pinned to an underwriter');

  const bySender = matchInbound({ from: { email: 'JO@alpha.test' }, subject: 'Terms' }, CANDIDATES);
  assert.equal(bySender.candidate.recipient_id, 'r1', 'the newest submission to that address wins');
  assert.equal(bySender.how, 'sender');

  assert.equal(matchInbound({ from: { email: 'nobody@nowhere.test' }, subject: 'Hello' }, CANDIDATES), null);
});

test('an HTML body reads as plain text', () => {
  const text = bodyText({ contentType: 'html', content: '<html><body><p>Dear Jo,</p><p>Line of <b>10%</b> &amp; ROL 8%.</p><br><div>Regards</div></body></html>' });
  assert.equal(text, 'Dear Jo,\n\nLine of 10% & ROL 8%.\n\nRegards');
  assert.equal(bodyText({ contentType: 'text', content: '  plain  ' }), 'plain');
  assert.equal(bodyText(null), '');
});
