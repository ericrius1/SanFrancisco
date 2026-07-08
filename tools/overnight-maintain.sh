#!/bin/zsh
# Overnight self-maintenance for the AI-car fleet, independent of any agent turn.
#  - keeps the headless trainer alive (restart resumes from its checkpoint)
#  - re-pushes the trained pool to the live relay every cycle, so the city stays
#    competent even if Railway restarts the container or a concurrent redeploy
#    wipes the relay's in-memory / ephemeral-disk pool.
cd /Users/eric/codeprojects/sanfrancisco
LOG=/private/tmp/claude-501/-Users-eric-codeprojects-sanfrancisco/99aecd62-6add-4602-b253-32a9e7861c7f/scratchpad/maintain.log
CKPT=tools/aicars-trained.json
TRAINER_LOG=/private/tmp/claude-501/-Users-eric-codeprojects-sanfrancisco/99aecd62-6add-4602-b253-32a9e7861c7f/scratchpad/trainer.log
while true; do
  ts=$(date +%H:%M:%S)
  if ! pgrep -f "train-cars-headless" >/dev/null; then
    echo "$ts trainer down — restarting" >> $LOG
    nohup node --experimental-strip-types tools/train-cars-headless.mjs >> $TRAINER_LOG 2>&1 &
    sleep 15
  fi
  if [ -f $CKPT ]; then
    res=$(node tools/push-brains-to-prod.mjs 2>&1 | grep -oE "sent [0-9]+ brains|NOT leader|error|timeout" | head -1)
    echo "$ts push: ${res:-no-op}" >> $LOG
  fi
  sleep 1200
done
