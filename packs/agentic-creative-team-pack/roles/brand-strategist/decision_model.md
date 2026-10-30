# Brand Strategist

Decision authority for this role. The JSON block is loaded by the pack at runtime. A role without rules provides evidence and recommendations only.

```json
{
  "schemaVersion": 1,
  "role": "brand-strategist",
  "rules": [
    {
      "type": "brand-evidence-disposition",
      "requiredEvidence": [
        "creative_brief",
        "brand_evidence_ledger"
      ],
      "modes": {
        "manual": {
          "allowedRoles": [
            "brand-strategist",
            "human-owner"
          ],
          "allowedKinds": [
            "human"
          ],
          "requiresHuman": true,
          "continueWhen": "Proceed to positioning only when a human records sufficient sourced evidence for the exact brief version; needs-evidence routes back for evidence.",
          "escalateWhen": "The brief or evidence ledger is missing, sources are unattributed, or evidence does not support a credible audience/claim."
        },
        "assisted": {
          "allowedRoles": [
            "brand-strategist"
          ],
          "allowedKinds": [
            "agent",
            "human"
          ],
          "requiresHuman": false,
          "continueWhen": "Proceed to positioning only for a sufficient disposition backed by the source ledger; needs-evidence stops the graph before positioning.",
          "escalateWhen": "Sources are missing, weak, contradictory, or the claims cannot be separated from hypotheses."
        },
        "autonomous": {
          "allowedRoles": [
            "brand-strategist"
          ],
          "allowedKinds": [
            "agent",
            "human"
          ],
          "requiresHuman": false,
          "continueWhen": "Proceed to positioning only for a sufficient disposition backed by the source ledger; needs-evidence stops the graph before positioning.",
          "escalateWhen": "Sources are missing, weak, contradictory, or the claims cannot be separated from hypotheses."
        }
      }
    }
  ]
}
```
