# Creative Director

Decision authority for this role. The JSON block is loaded by the pack at runtime. A role without rules provides evidence and recommendations only.

```json
{
  "schemaVersion": 1,
  "role": "creative-director",
  "rules": [
    {
      "type": "brand-direction-acceptance",
      "requiredEvidence": [
        "positioning",
        "brand_promise",
        "territory_set",
        "identity_review"
      ],
      "modes": {
        "manual": {
          "allowedRoles": [
            "human-owner",
            "creative-director"
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
            "creative-director"
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
            "creative-director"
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
      "type": "brand-baseline-change",
      "requiredEvidence": [
        "current_brand_baseline",
        "proposed_delta",
        "touchpoint_impact"
      ],
      "modes": {
        "manual": {
          "allowedRoles": [
            "human-owner",
            "creative-director"
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
            "creative-director"
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
            "creative-director"
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
      "type": "brand-foundation-disposition",
      "requiredEvidence": [
        "brand_strategy",
        "brand_identity_system",
        "brand_voice_system",
        "evidence_quality",
        "review_findings"
      ],
      "modes": {
        "manual": {
          "allowedRoles": [
            "human-owner",
            "creative-director"
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
            "human-owner",
            "creative-director"
          ],
          "allowedKinds": [
            "human"
          ],
          "requiresHuman": true,
          "continueWhen": "Write a durable Decision Record that cites the exact evidence and artifact versions for this disposition.",
          "escalateWhen": "Required evidence is missing, the subject version changed, or findings cannot be resolved within this role's authority."
        },
        "autonomous": {
          "allowedRoles": [
            "human-owner",
            "creative-director"
          ],
          "allowedKinds": [
            "human"
          ],
          "requiresHuman": true,
          "continueWhen": "Write a durable Decision Record that cites the exact evidence and artifact versions for this disposition.",
          "escalateWhen": "Required evidence is missing, the subject version changed, or findings cannot be resolved within this role's authority."
        }
      }
    },
    {
      "type": "campaign-disposition",
      "requiredEvidence": [
        "brand_baseline_version",
        "campaign_brief_version",
        "channel_asset_versions",
        "claims_and_sources",
        "brand_review",
        "asset_rights_manifest"
      ],
      "modes": {
        "manual": {
          "allowedRoles": [
            "human-owner",
            "creative-director"
          ],
          "allowedKinds": [
            "human"
          ],
          "requiresHuman": true,
          "continueWhen": "Write a durable Decision Record for the exact candidate and baseline versions, citing every required review artifact.",
          "escalateWhen": "Required evidence is missing, the baseline or subject version changed, or findings exceed this role's authority."
        },
        "assisted": {
          "allowedRoles": [
            "creative-director"
          ],
          "allowedKinds": [
            "agent",
            "human"
          ],
          "requiresHuman": false,
          "continueWhen": "Write a durable Decision Record for the exact candidate and baseline versions, citing every required review artifact.",
          "escalateWhen": "Required evidence is missing, the baseline or subject version changed, or findings exceed this role's authority."
        },
        "autonomous": {
          "allowedRoles": [
            "creative-director"
          ],
          "allowedKinds": [
            "agent",
            "human"
          ],
          "requiresHuman": false,
          "continueWhen": "Write a durable Decision Record for the exact candidate and baseline versions, citing every required review artifact.",
          "escalateWhen": "Required evidence is missing, the baseline or subject version changed, or findings exceed this role's authority."
        }
      }
    }
  ]
}
```
