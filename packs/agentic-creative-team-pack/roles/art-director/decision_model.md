# Art Director

Decision authority for this role. The JSON block is loaded by the pack at runtime. A role without rules provides evidence and recommendations only.

```json
{
  "schemaVersion": 1,
  "role": "art-director",
  "rules": [
    {
      "type": "concept-count",
      "requiredEvidence": [
        "requested_count",
        "brief_uncertainty",
        "comparison_rationale"
      ],
      "modes": {
        "manual": {
          "allowedRoles": [
            "human-owner",
            "art-director"
          ],
          "allowedKinds": [
            "human"
          ],
          "requiresHuman": true,
          "continueWhen": "Write a durable Decision Record that cites the exact evidence and artifact versions for this disposition.",
          "escalateWhen": "Required evidence is missing, the subject version changed, or findings cannot be resolved within this role's authority."
        },
        "assisted": {
          "allowedRoles": [
            "art-director"
          ],
          "allowedKinds": [
            "agent",
            "human"
          ],
          "requiresHuman": false,
          "continueWhen": "Write a durable Decision Record that cites the exact evidence and artifact versions for this disposition.",
          "escalateWhen": "Required evidence is missing, the subject version changed, or findings cannot be resolved within this role's authority."
        },
        "autonomous": {
          "allowedRoles": [
            "art-director"
          ],
          "allowedKinds": [
            "agent",
            "human"
          ],
          "requiresHuman": false,
          "continueWhen": "Write a durable Decision Record that cites the exact evidence and artifact versions for this disposition.",
          "escalateWhen": "Required evidence is missing, the subject version changed, or findings cannot be resolved within this role's authority."
        }
      }
    },
    {
      "type": "concept-set-status",
      "requiredEvidence": [
        "requested_count",
        "concept_versions",
        "image_checks",
        "distinctness_review"
      ],
      "modes": {
        "manual": {
          "allowedRoles": [
            "human-owner",
            "art-director"
          ],
          "allowedKinds": [
            "human"
          ],
          "requiresHuman": true,
          "continueWhen": "Write a durable Decision Record that cites the exact evidence and artifact versions for this disposition.",
          "escalateWhen": "Required evidence is missing, the subject version changed, or findings cannot be resolved within this role's authority."
        },
        "assisted": {
          "allowedRoles": [
            "art-director"
          ],
          "allowedKinds": [
            "agent",
            "human"
          ],
          "requiresHuman": false,
          "continueWhen": "Write a durable Decision Record that cites the exact evidence and artifact versions for this disposition.",
          "escalateWhen": "Required evidence is missing, the subject version changed, or findings cannot be resolved within this role's authority."
        },
        "autonomous": {
          "allowedRoles": [
            "art-director"
          ],
          "allowedKinds": [
            "agent",
            "human"
          ],
          "requiresHuman": false,
          "continueWhen": "Write a durable Decision Record that cites the exact evidence and artifact versions for this disposition.",
          "escalateWhen": "Required evidence is missing, the subject version changed, or findings cannot be resolved within this role's authority."
        }
      }
    }
  ]
}
```
