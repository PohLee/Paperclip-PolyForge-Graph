# Head of Design

Decision authority for this role. The JSON block is loaded by the pack at runtime. A role without rules provides evidence and recommendations only.

```json
{
  "schemaVersion": 1,
  "role": "head-of-design",
  "rules": [
    {
      "type": "cross-domain-design-disposition",
      "requiredEvidence": [
        "current_product_decision",
        "brand_baseline",
        "design_baseline",
        "cross_domain_tradeoffs"
      ],
      "modes": {
        "manual": {
          "allowedRoles": [
            "human-owner",
            "head-of-design"
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
            "head-of-design"
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
            "head-of-design"
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
    },
    {
      "type": "creative-routing",
      "requiredEvidence": [
        "creative_brief",
        "scope",
        "surfaceMode",
        "explorationMode"
      ],
      "modes": {
        "manual": {
          "allowedRoles": [
            "human-owner",
            "head-of-design"
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
            "head-of-design"
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
            "head-of-design"
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
      "type": "concept-selection",
      "requiredEvidence": [
        "concept_set",
        "comparison_criteria",
        "selected_candidate_version",
        "human_choice"
      ],
      "modes": {
        "manual": {
          "allowedRoles": [
            "head-of-design",
            "human-owner"
          ],
          "allowedKinds": [
            "human"
          ],
          "requiresHuman": true,
          "continueWhen": "Continue only after a human-owner Decision Record selects an exact candidate version and cites comparison evidence.",
          "escalateWhen": "No authenticated human choice is present, delegation cannot be verified by the host, evidence is missing, or the selected candidate version is stale."
        },
        "assisted": {
          "allowedRoles": [
            "head-of-design",
            "human-owner"
          ],
          "allowedKinds": [
            "human"
          ],
          "requiresHuman": true,
          "continueWhen": "Continue only after a human-owner Decision Record selects an exact candidate version and cites comparison evidence.",
          "escalateWhen": "No authenticated human choice is present, delegation cannot be verified by the host, evidence is missing, or the selected candidate version is stale."
        },
        "autonomous": {
          "allowedRoles": [
            "head-of-design",
            "human-owner"
          ],
          "allowedKinds": [
            "human"
          ],
          "requiresHuman": true,
          "continueWhen": "Continue only after a human-owner Decision Record selects an exact candidate version and cites comparison evidence.",
          "escalateWhen": "No authenticated human choice is present, delegation cannot be verified by the host, evidence is missing, or the selected candidate version is stale."
        }
      }
    }
  ]
}
```
