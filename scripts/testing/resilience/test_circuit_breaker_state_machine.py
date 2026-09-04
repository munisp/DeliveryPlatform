import unittest

class Breaker:
    def __init__(self): self.state='closed'; self.evidence=''
    def alert_open(self, allowed=True):
        if not allowed: return False
        if self.state == 'closed': self.state='open'
        return self.state == 'open'
    def half_open(self, evidence):
        if self.state != 'open' or not evidence: return False
        self.state='half_open'; self.evidence=evidence; return True
    def probe(self, passed):
        if self.state != 'half_open': return False
        self.state = 'half_open' if passed else 'open'; return passed
    def close(self, evidence):
        if self.state != 'half_open' or not evidence or evidence != self.evidence: return False
        self.state='closed'; return True

class TestStateMachine(unittest.TestCase):
    def test_full_recovery(self):
        b=Breaker(); self.assertTrue(b.alert_open()); self.assertTrue(b.half_open('recovery-1')); self.assertTrue(b.probe(True)); self.assertTrue(b.close('recovery-1')); self.assertEqual(b.state,'closed')
    def test_failure_reopens(self):
        b=Breaker(); b.alert_open(); b.half_open('recovery-1'); self.assertFalse(b.probe(False)); self.assertEqual(b.state,'open')
    def test_webhook_cannot_close(self):
        b=Breaker(); b.alert_open(); self.assertFalse(b.close('recovery-1')); self.assertEqual(b.state,'open')
    def test_evidence_required(self):
        b=Breaker(); b.alert_open(); self.assertFalse(b.half_open('')); self.assertEqual(b.state,'open')

if __name__ == '__main__': unittest.main()
