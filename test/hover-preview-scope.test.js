const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('message hover previews are bound only to template rows', () => {
  const templateBindings = appSource.match(/bindHoverPreview\(tr,\s*t\)/g) || [];
  const queueBindings = appSource.match(/bindQueueHoverPreview\(tr,\s*r\)/g) || [];

  assert.equal(templateBindings.length, 1, 'template list rows should keep their hover preview');
  assert.equal(queueBindings.length, 0, 'queue rows should not open a hover preview');
});
