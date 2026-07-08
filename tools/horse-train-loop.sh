#!/bin/zsh
# Overnight horse-gait refiner. Runs ES rounds, each warm-starting from the last
# round's best, writing a CANDIDATE policy (horse_policy.trained.json) — NEVER the
# live good.json the herd loads. So training can't degrade the running herd; a
# verified-better candidate is promoted separately (by an agent heartbeat / in the
# morning) after an upright+moving headless check.
cd /Users/eric/codeprojects/sanfrancisco
LOG=/private/tmp/claude-501/-Users-eric-codeprojects-sanfrancisco/99aecd62-6add-4602-b253-32a9e7861c7f/scratchpad/horse-train.log
CAND=public/models/horse_policy.trained.json
WARM=public/models/horse_policy.good.json   # round 1 warms from the proven gait
for round in $(seq 1 200); do
  echo "=== round $round $(date +%H:%M:%S) warm=$WARM ===" >> $LOG
  OUT=$CAND WARM=$WARM node --experimental-strip-types rl/train.ts \
    --creature horse --gens 120 --pairs 64 --steps 500 --warm >> $LOG 2>&1
  [ -f $CAND ] && WARM=$CAND   # subsequent rounds refine the candidate
done
