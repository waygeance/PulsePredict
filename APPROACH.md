# Event-Driven Congestion Prediction — Approach Document

**Hackathon:** Gridlock / Traffic Intelligence  
**Problem:** Planned & Unplanned Event-Driven Congestion  
**Dataset:** Astram event data (~8,200 real traffic incidents, Bengaluru)

---

## 1. Problem Framing

Traffic operations teams today rely on experience-based gut calls — they don't know in advance how long an event will disrupt traffic, whether a road needs to be fully closed, or how many personnel to send. There is no feedback loop to learn from resolved incidents.

We reframe this as three learnable ML tasks:

| Sub-problem | ML Formulation | Business Output |
|-------------|---------------|-----------------|
| How long will it last? | Regression on `duration_hours` | Personnel shift planning |
| Will the road close? | Binary classification on `requires_road_closure` | Barricade pre-positioning |
| How bad is it overall? | Weighted ensemble score 0–10 | Prioritized dispatch queue |
| What resources do I send? | Rule-based recommender | Manpower / barricade / diversion plan |

---

## 2. Dataset Understanding

**Source:** Astram traffic management system, Bengaluru (~Nov 2023 – Apr 2024)  
**Records:** 8,173 incidents, 46 columns

### Key findings from EDA

**Class composition:**
- 94% `unplanned` events, 6% `planned`
- Top unplanned causes: vehicle breakdown (60%), potholes, water-logging, construction
- Top planned causes: public events, processions, VIP movement

**Temporal patterns:**
- Two clear peaks: early morning surge (4–7 AM IST) and evening rush (7–10 PM IST)
- Planned events cluster more in evening hours and weekends
- March has the highest incident density in the dataset

**Spatial patterns:**
- Concentrated within Bengaluru city limits (lat ~12.8–13.3, lon ~77.3–77.8)
- Top hotspot junctions: Mekhri Circle, Silk Board, Yeshwanthpura Circle, Jalahalli Cross
- Mysore Road and Bellary Road corridors are highest-incident corridors

**Road closures:**
- Only 8.2% of incidents require road closure — severe class imbalance handled via `scale_pos_weight`
- Highest closure rates: VIP movement (80%), tree fall (39%), public events (46%), construction (26%)

**Duration:**
- Median resolution: ~1 hour, Mean: ~4 hours (heavy right skew)
- Outliers up to 3,000+ hours (data quality issues / open cases)
- Log-transform applied before regression

**Missing data strategy:**
- Columns >80% null: dropped from features (comment, map_file, meta_data, direction, etc.)
- Categorical nulls filled with `'unknown'` before encoding
- Duration target only computed where `closed_datetime` or `resolved_datetime` is available

---

## 3. Feature Engineering

All temporal, spatial, and contextual signals extracted from raw columns:

### Temporal features
| Feature | Derivation | Why it matters |
|---------|-----------|----------------|
| `hour` | `start_datetime.dt.hour` | Peak vs off-peak hours |
| `dow_num` | Day of week (0=Mon) | Weekend vs weekday behavior |
| `month` | Month number | Seasonal variation |
| `is_weekend` | `dow_num >= 5` | Lower staffing on weekends |
| `is_peak_am` | hour in [6,9] | Morning rush multiplier |
| `is_peak_pm` | hour in [17,20] | Evening rush multiplier |
| `is_nighttime` | hour <= 5 | Lower visibility, different incident types |

### Spatial features
| Feature | Derivation | Why it matters |
|---------|-----------|----------------|
| `dist_from_centre` | Haversine from MG Road (~city centre) | Peripheral vs central congestion patterns differ |
| `is_corridor` | Not `Non-corridor` | Arterial roads have faster incident response |
| `has_junction` | `junction` is not null | Junction incidents are more complex |
| `junction_hotspot_score` | Frequency of incidents at that junction | Historical recurrence signal |
| `zone_risk_score` | Zone-level incident frequency | Area-level baseline risk |

### Event metadata features
| Feature | Derivation | Why it matters |
|---------|-----------|----------------|
| `is_planned` | `event_type == 'planned'` | Planned events allow pre-deployment |
| `cause_category` | Grouped from `event_cause` | Reduces cardinality, improves generalization |
| `priority_num` | High=1, Low=0 | Direct operator severity assessment |

### Cause grouping
Raw `event_cause` values consolidated into 5 groups:
- `public_event` → processions, rallies, VIP movement, protests
- `infrastructure` → potholes, water-logging, construction, road conditions
- `vehicle` → vehicle breakdown, accidents
- `natural` → tree fall, fog
- `others` → remaining

---

## 4. Model Architecture

### Model 1: Duration Regression (LightGBM)

**Why LightGBM?**  
- Handles mixed types (categorical + numerical) natively
- Fast training on medium-sized tabular data
- Superior performance on skewed targets with log-transform
- Supports early stopping to prevent overfitting

**Target:** `log1p(duration_hours)` — log-transform handles extreme right skew (incidents lasting seconds vs days)

**Key hyperparameters:**
```
n_estimators   = 600 (with early stopping @ 50)
learning_rate  = 0.05
num_leaves     = 63
subsample      = 0.8
colsample_bytree = 0.8
reg_alpha/lambda = 0.1  (L1/L2 regularization)
```

**Evaluation:** MAE (in original hours after `expm1` back-transform), R² on log scale

---

### Model 2: Road Closure Classification (XGBoost)

**Why XGBoost?**  
- Proven strong baseline on binary classification with tabular data
- `scale_pos_weight` natively handles the 1:11 class imbalance (8% closure rate)
- Provides probability scores (not just binary), enabling threshold tuning

**Threshold:** 0.4 (tuned down from 0.5 to favor recall — better to over-deploy than miss a closure)

**Key hyperparameters:**
```
n_estimators   = 500 (early stopping)
learning_rate  = 0.05
max_depth      = 6
scale_pos_weight = ~11 (neg/pos ratio)
```

**Evaluation:** ROC-AUC (insensitive to imbalance), Precision/Recall on positive class

---

### Ensemble: Traffic Impact Score

Combines both model outputs into a single priority score `[0, 10]`:

```
Impact Score = clip(
    0.35 × (predicted_duration / 20)   ← normalized duration
  + 0.35 × (closure_probability × 10) ← road closure risk
  + 0.15 × (priority_num × 1.5)       ← operator priority
  + 0.15 × (junction_hotspot / 20)    ← location risk
, 0, 10)
```

Weight rationale:
- Duration and closure probability carry equal weight (35% each) as primary severity signals
- Priority captures field-assessed urgency (15%)
- Historical hotspot score captures recurrence risk at that location (15%)

---

## 5. Resource Recommendation Engine

A rule-based heuristic layer converts the Impact Score into an actionable deployment plan:

### Alert Levels
| Score Range | Level | Manpower (base) | Barricades | Diversion Routes | Patrol (min) |
|------------|-------|-----------------|------------|-----------------|--------------|
| 0.0 – 2.5 | LOW | 2 | 0 | 0 | 60 |
| 2.5 – 5.0 | MEDIUM | 5 | 4 | 1 | 30 |
| 5.0 – 7.5 | HIGH | 10 | 10 | 2 | 15 |
| 7.5 – 10.0 | CRITICAL | 20 | 20 | 3 | 10 |

### Adjustments on top of base
- `closure_prob > 0.6` → manpower × 1.5
- `predicted_hours > 6` → manpower + 3 (shift rotation needed)
- `closure_prob > 0.5` → barricades = max(base, closure_prob × 25)

### Contextual action notes (cause-specific)
- `public_event/procession` → coordinate with organizers
- `construction` → enforce night-hour work windows
- `accident/breakdown` → tow truck + emergency services
- `is_planned = True` → pre-deploy 2 hours before event start

---

## 6. Post-Event Learning Loop

The model predictions can be compared against actual outcomes once an event is resolved:

- **`closed_datetime`** → actual end time → real duration computable
- **`requires_road_closure`** (actual) → compare with predicted probability
- **`resolved_at_latitude/longitude`** → was the incident resolved at a different location?

This enables:
1. **Zone-level accuracy tracking** — where does the model under/over-estimate?
2. **Cause-level calibration** — are vehicle breakdowns better predicted than processions?
3. **Continuous retraining** — append new resolved incidents monthly and retrain

---

## 7. Limitations & Future Work

| Limitation | Mitigation / Future |
|-----------|---------------------|
| ~60% dataset is vehicle breakdowns — models skew toward that cause | Weight balanced training; separate model per cause category |
| No real-time traffic density data | Integrate Google Maps / HERE traffic API as features |
| Duration target sparse (only 39% have valid duration) | Semi-supervised imputation; separate model for open vs closed events |
| Single-city (Bengaluru) — low generalizability | Collect multi-city data; add city-type embeddings |
| Rule-based recommender not learned from data | Train an RL agent on deployment logs to optimize manpower vs response time |
| No event magnitude data (size of procession, crowd count) | Enrich with external data: police permit databases, social media signals |

---

## 8. Reproducibility

```bash
pip install lightgbm xgboost scikit-learn pandas numpy matplotlib seaborn

# Update CSV_PATH in Cell 2 of the notebook
CSV_PATH = 'path/to/Astram_event_data_anonymized.csv'

# Run all cells top to bottom
jupyter nbconvert --to notebook --execute event_congestion_hackathon.ipynb
```

Output file: `event_congestion_scored_output.csv`  
Contains: all original rows + `impact_score`, `alert_level`, `manpower`, `barricades`, `diversion_routes`, `action_notes`

---

## 9. Key Takeaways for Judges

1. **Quantified event impact** — from "officer intuition" to a reproducible 0–10 score with model-backed confidence
2. **Dual-model pipeline** — duration + road closure together capture both temporal and spatial disruption
3. **Cause-aware recommendations** — not a generic alert, but specific instructions per event type
4. **Post-event feedback loop** — architecture designed for continuous improvement as data grows
5. **Production-ready output** — scored CSV can be consumed by any dispatch system or dashboard directly
