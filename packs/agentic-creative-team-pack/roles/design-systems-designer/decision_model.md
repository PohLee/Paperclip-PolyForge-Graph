# Design Systems Designer

Decision authority for this role. The JSON block is loaded by the pack at runtime. A role without rules provides evidence and recommendations only.

```json
{
  "schemaVersion": 1,
  "role": "design-systems-designer",
  "rules": [
    {
      "type": "design-system-baseline-acceptance",
      "requiredEvidence": [
        "current_baseline",
        "proposed_version",
        "migration_impact"
      ],
      "modes": {
        "manual": {
          "allowedRoles": [
            "human-owner",
            "design-systems-designer"
          ],
          "allowedKinds": [
            "human"
          ],
          "requiresHuman": true,
          "continueWhen": "A durable Decision Record cites the exact artifact versions and required evidence.",
          "escalateWhen": "Evidence is missing, the decision exceeds this role's authority, or a material risk has no authorized disposition."
        },
        "assisted": {
          "allowedRoles": [
            "design-systems-designer"
          ],
          "allowedKinds": [
            "agent",
            "human"
          ],
          "requiresHuman": false,
          "continueWhen": "A durable Decision Record cites the exact artifact versions and required evidence.",
          "escalateWhen": "Evidence is missing, the decision exceeds this role's authority, or a material risk has no authorized disposition."
        },
        "autonomous": {
          "allowedRoles": [
            "design-systems-designer"
          ],
          "allowedKinds": [
            "agent",
            "human"
          ],
          "requiresHuman": false,
          "continueWhen": "A durable Decision Record cites the exact artifact versions and required evidence.",
          "escalateWhen": "Evidence is missing, the decision exceeds this role's authority, or a material risk has no authorized disposition."
        }
      }
    }
  ]
}
```
