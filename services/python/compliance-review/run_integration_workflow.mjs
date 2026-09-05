import { writeFile } from 'node:fs/promises';

const baseUrl = process.env.COMPLIANCE_URL;
const token = process.env.INTERNAL_SERVICE_TOKEN;
if (!baseUrl || !token) throw new Error('COMPLIANCE_URL and INTERNAL_SERVICE_TOKEN are required');
const headers = { 'content-type': 'application/json', 'x-internal-service-token': token, 'x-actor-user-id': '1' };

async function request(path, method = 'POST', payload = undefined) {
  const response = await fetch(`${baseUrl}${path}`, { method, headers, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

const post = (path, payload = undefined) => request(path, 'POST', payload);
const get = (path) => request(path, 'GET');

const requirements = [
  ['driver', '101', 'national_driver_license', false],
  ['driver', '101', 'lasdri_certificate', false],
  ['driver', '101', 'identity_check', false],
  ['driver', '101', 'background_screening', true],
  ['driver', '101', 'training', false],
  ['vehicle', 'f1000000-0000-4000-8000-000000000101', 'vehicle_registration', false],
  ['vehicle', 'f1000000-0000-4000-8000-000000000101', 'roadworthiness', true],
  ['vehicle', 'f1000000-0000-4000-8000-000000000101', 'vehicle_inspection', true],
  ['vehicle', 'f1000000-0000-4000-8000-000000000101', 'commercial_motor_insurance', true],
  ['vehicle', 'f1000000-0000-4000-8000-000000000101', 'passenger_liability_cover', true],
  ['operator', 'lagos-private-beta', 'operator_permit', true],
];
const evidence = [];
for (const [subjectKind, subjectKey, evidenceType, humanApproval] of requirements) {
  const submitted = await post('/evidence', {
    subject_kind: subjectKind,
    subject_key: subjectKey,
    evidence_type: evidenceType,
    external_reference: `integration-${evidenceType}`,
    verifier: 'integration-approved-verifier',
    document_object_key: `restricted/integration/${evidenceType}.pdf`,
    issued_at: '2026-08-01T00:00:00Z',
    expires_at: '2027-08-01T00:00:00Z',
  });
  const verified = await post(`/evidence/${submitted.evidence_id}/verify`);
  if (verified.outcome !== 'verified') throw new Error(`provider did not verify ${evidenceType}`);
  let approved = null;
  if (humanApproval) {
    approved = await post(`/evidence/${submitted.evidence_id}/approve`, { reviewer_user_id: 1, approved: true, reason: 'integration approved verified Lagos compliance evidence' });
    if (approved.state !== 'verified') throw new Error(`human approval did not verify ${evidenceType}`);
  }
  evidence.push({ evidenceType, evidenceId: submitted.evidence_id, verified, approved });
}
const eligibilityBeforeExpiry = await get('/drivers/101/eligibility');
if (!eligibilityBeforeExpiry.eligible || eligibilityBeforeExpiry.presence_state !== 'offline') throw new Error(`expected eligible offline driver before expiry: ${JSON.stringify(eligibilityBeforeExpiry)}`);
const result = { passed: true, evidence_count: evidence.length, eligibility_before_expiry: eligibilityBeforeExpiry };
await writeFile(process.env.OUTPUT_PATH, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(result)}\n`);
