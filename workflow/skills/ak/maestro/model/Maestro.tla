---- MODULE Maestro ----
EXTENDS Naturals, FiniteSets

CONSTANTS Issues, Workers, Blocks, Recheck, MaxRestart, SkipNudge, NudgeMax

VARIABLES s, rq, nud, wk, pend, wake, hb, owe, rs, pr
vars == <<s, rq, nud, wk, pend, wake, hb, owe, rs, pr>>
\* pr[i]: the builder opened the PR and labelled the issue ready-for-review, so its next claim is a review

BlocksVal == {<<"A", "B">>}  \* B is blocked by A; cfg cannot hold tuples, so it is wired in with Blocks <- BlocksVal
None == "-"
Idle == [k |-> "Idle", i |-> None, r |-> None]
Deps(i) == {d \in Issues : <<d, i>> \in Blocks}
Unblocked(i) == \A d \in Deps(i) : s[d] = "Merged"
Holds(i) == {w \in Workers : wk[w].k # "Idle" /\ wk[w].i = i}
HasIdle == \E w \in Workers : wk[w].k = "Idle"
AllMerged == \A i \in Issues : s[i] = "Merged"

Init == /\ s = [i \in Issues |-> "Ready"] /\ rq = [i \in Issues |-> FALSE] /\ nud = [i \in Issues |-> 0]
        /\ wk = [w \in Workers |-> Idle] /\ pend = None /\ wake = TRUE /\ hb = "on" /\ owe = FALSE /\ rs = 0 /\ pr = [i \in Issues |-> FALSE]

\* ---- maestro (acts only while a tick is running) ----
Free(w) == wk' = [wk EXCEPT ![w] = Idle]
Open(i) == IF pr[i] THEN "Review" ELSE "Ready"   \* which frontier an unclaimed issue rejoins
Requeue(i) == IF rq[i] THEN /\ s' = [s EXCEPT ![i] = "Help"] /\ rq' = rq
              ELSE /\ s' = [s EXCEPT ![i] = Open(i)] /\ rq' = [rq EXCEPT ![i] = TRUE]
\* the worker's part is over: merged, handed to review, or already with the master (stalled)
Settled(i) == s[i] \in {"Merged", "Review", "Help"}

MaestroReapsMerged(w)     == /\ wake /\ wk[w].k = "Fin" /\ Settled(wk[w].i) /\ Free(w) /\ UNCHANGED <<s, rq, nud, pend, wake, hb, owe, rs, pr>>
MaestroReapsHelp(w)       == /\ wake /\ wk[w].k = "Fin" /\ s[wk[w].i] = "ClaimedHelp" /\ s' = [s EXCEPT ![wk[w].i] = "Help"] /\ Free(w) /\ UNCHANGED <<rq, nud, pend, wake, hb, owe, rs, pr>>
MaestroNudgesWorker(w)    == /\ wake /\ wk[w].k = "Fin" /\ ~(s[wk[w].i] \in {"Merged", "ClaimedHelp", "Review", "Help"}) /\ wk[w].r = "quit" /\ nud[wk[w].i] < NudgeMax
                             /\ nud' = [nud EXCEPT ![wk[w].i] = @ + 1] /\ wk' = [wk EXCEPT ![w] = [k |-> "Run", i |-> wk[w].i, r |-> None]]
                             /\ UNCHANGED <<s, rq, pend, wake, hb, owe, rs, pr>>
MaestroGivesUpNudging(w)  == /\ wake /\ wk[w].k = "Fin" /\ ~(s[wk[w].i] \in {"Merged", "ClaimedHelp", "Review", "Help"}) /\ wk[w].r = "quit" /\ nud[wk[w].i] >= NudgeMax
                             /\ s' = [s EXCEPT ![wk[w].i] = "Help"] /\ Free(w) /\ UNCHANGED <<rq, nud, pend, wake, hb, owe, rs, pr>>
MaestroRequeuesDied(w)    == /\ wake /\ wk[w].k = "Fin" /\ ~(s[wk[w].i] \in {"Merged", "ClaimedHelp", "Review", "Help"}) /\ wk[w].r # "quit" /\ Requeue(wk[w].i) /\ Free(w)
                             /\ UNCHANGED <<nud, pend, wake, hb, owe, rs, pr>>
OrphanEn(i) == s[i] = "Claimed" /\ pend # i /\ Holds(i) = {}
\* gap 1 fix: after a restart, an in-progress + needs-help issue nobody holds is reaped and the master told
OrphanHelpEn(i) == s[i] = "ClaimedHelp" /\ Holds(i) = {}
MaestroReapsOrphanHelp(i) == /\ wake /\ OrphanHelpEn(i) /\ s' = [s EXCEPT ![i] = "Help"] /\ UNCHANGED <<rq, nud, wk, pend, wake, hb, owe, rs, pr>>
MaestroRequeuesOrphan(i)  == /\ wake /\ OrphanEn(i) /\ Requeue(i) /\ UNCHANGED <<nud, wk, pend, wake, hb, owe, rs, pr>>
\* Holds(i) = {}: the dispatcher skips an issue whose last thread still runs (a builder not yet reaped, a stalled worker)
ClaimEn(i) == pend = None /\ HasIdle /\ Unblocked(i) /\ Holds(i) = {} /\ IF Recheck THEN s[i] \in {"Ready", "Review"} ELSE s[i] \in {"Ready", "Review", "Claimed"}
MaestroClaims(i)          == /\ wake /\ ClaimEn(i) /\ s' = [s EXCEPT ![i] = "Claimed"] /\ pend' = i /\ UNCHANGED <<rq, nud, wk, wake, hb, owe, rs, pr>>
SpawnEn == pend # None /\ HasIdle
MaestroSpawns(w)          == /\ wake /\ pend # None /\ wk[w].k = "Idle" /\ wk' = [wk EXCEPT ![w] = [k |-> "Run", i |-> pend, r |-> None]] /\ pend' = None
                             /\ UNCHANGED <<s, rq, nud, wake, hb, owe, rs, pr>>
Busy == \E w \in Workers : wk[w].k # "Idle"
\* gap 2 fix: keep the heartbeat while a person may still unblock work without nudging
WaitingOnPeople == \E i \in Issues : s[i] = "Help" \/ (s[i] # "Merged" /\ ~Unblocked(i))
Front == \E i \in Issues : s[i] \in {"Ready", "Review"} /\ Unblocked(i)
\* stuck detection: a running worker with no push, comment or label change for too long goes to the master; its thread keeps running
MaestroFlagsStall(w)      == /\ wake /\ wk[w].k = "Run" /\ s[wk[w].i] = "Claimed" /\ s' = [s EXCEPT ![wk[w].i] = "Help"] /\ UNCHANGED <<rq, nud, wk, pend, wake, hb, owe, rs, pr>>
MaestroEndsTick           == /\ wake
                             /\ ~(\E w \in Workers : wk[w].k = "Fin") /\ ~(\E i \in Issues : OrphanEn(i) \/ OrphanHelpEn(i)) /\ ~(\E i \in Issues : ClaimEn(i)) /\ ~SpawnEn
                             /\ wake' = FALSE
                             /\ hb' = IF AllMerged THEN "deleted" ELSE IF ~Busy /\ ~Front /\ pend = None /\ ~WaitingOnPeople THEN "paused" ELSE hb
                             /\ UNCHANGED <<s, rq, nud, wk, pend, owe, rs, pr>>

\* ---- workers ----
\* a stalled worker that ends late leaves needs-help (Help) and a closed issue (Merged) as they are, unless it merges
WorkerEnds(w, st, r) == /\ wk[w].k = "Run" /\ s' = [s EXCEPT ![wk[w].i] = IF @ \in {"Help", "Merged"} /\ st # "Merged" THEN @ ELSE st] /\ wk' = [wk EXCEPT ![w] = [k |-> "Fin", i |-> wk[w].i, r |-> r]]
                        /\ wake' = TRUE /\ UNCHANGED <<rq, nud, pend, hb, owe, rs>>
\* a builder (no PR yet) hands off; only a reviewer merges
WorkerHandsOff(w) == /\ wk[w].k = "Run" /\ ~pr[wk[w].i] /\ WorkerEnds(w, "Review", "pr") /\ pr' = [pr EXCEPT ![wk[w].i] = TRUE]
WorkerMerges(w)  == /\ wk[w].k = "Run" /\ pr[wk[w].i] /\ WorkerEnds(w, "Merged", "merged") /\ pr' = pr
WorkerAsksHelp(w) == WorkerEnds(w, "ClaimedHelp", "help") /\ pr' = pr
WorkerQuits(w)   == /\ wk[w].k = "Run" /\ wk' = [wk EXCEPT ![w] = [k |-> "Fin", i |-> wk[w].i, r |-> "quit"]] /\ wake' = TRUE /\ UNCHANGED <<s, rq, nud, pend, hb, owe, rs, pr>>
WorkerDies(w)    == /\ wk[w].k = "Run" /\ wk' = [wk EXCEPT ![w] = [k |-> "Fin", i |-> wk[w].i, r |-> "died"]] /\ wake' = TRUE /\ UNCHANGED <<s, rq, nud, pend, hb, owe, rs, pr>>

\* ---- heartbeat, restart ----
HeartbeatFires   == /\ hb = "on" /\ ~wake /\ wake' = TRUE /\ UNCHANGED <<s, rq, nud, wk, pend, hb, owe, rs, pr>>
MaestroRestarts  == /\ rs < MaxRestart /\ rs' = rs + 1
                    /\ wk' = [w \in Workers |-> IF wk[w].k = "Fin" THEN Idle ELSE wk[w]]
                    /\ nud' = [i \in Issues |-> 0] /\ pend' = None /\ wake' = TRUE /\ hb' = IF AllMerged THEN "deleted" ELSE "on"
                    /\ UNCHANGED <<s, rq, owe, pr>>

\* ---- master (a person) ----
MasterFinishes(i) == /\ s[i] = "Help" /\ s' = [s EXCEPT ![i] = "Merged"] /\ owe' = ~SkipNudge /\ UNCHANGED <<rq, nud, wk, pend, wake, hb, rs, pr>>
MasterReleases(i) == /\ s[i] = "Help" /\ s' = [s EXCEPT ![i] = Open(i)] /\ owe' = ~SkipNudge /\ UNCHANGED <<rq, nud, wk, pend, wake, hb, rs, pr>>
Wakes == /\ wake' = TRUE /\ hb' = IF hb = "paused" THEN "on" ELSE hb
MasterNudges     == /\ owe /\ owe' = FALSE /\ Wakes /\ UNCHANGED <<s, rq, nud, wk, pend, rs, pr>>
SomeoneNudges    == /\ ~owe /\ Wakes /\ UNCHANGED <<s, rq, nud, wk, pend, owe, rs, pr>>

Maestro == \/ \E w \in Workers : MaestroReapsMerged(w) \/ MaestroReapsHelp(w) \/ MaestroNudgesWorker(w) \/ MaestroGivesUpNudging(w) \/ MaestroRequeuesDied(w) \/ MaestroSpawns(w)
           \/ \E i \in Issues : MaestroRequeuesOrphan(i) \/ MaestroReapsOrphanHelp(i) \/ MaestroClaims(i)
           \/ \E w \in Workers : MaestroFlagsStall(w)
           \/ MaestroEndsTick
WorkerStep(w) == WorkerHandsOff(w) \/ WorkerMerges(w) \/ WorkerAsksHelp(w) \/ WorkerQuits(w) \/ WorkerDies(w)
Worker == \E w \in Workers : WorkerStep(w)
Master == \/ \E i \in Issues : MasterFinishes(i) \/ MasterReleases(i)
          \/ SomeoneNudges

Next == Maestro \/ Worker \/ HeartbeatFires \/ MaestroRestarts \/ Master \/ MasterNudges
Spec == Init /\ [][Next]_vars

\* ---- rules ----
OneWorkerPerIssue == \A i \in Issues : Cardinality(Holds(i)) <= 1
NeverClaimBlocked == \A i \in Issues : s[i] \in {"Claimed", "ClaimedHelp", "Review", "Merged"} => Unblocked(i)
Waiting(i) == s[i] \in {"Merged", "Help"} \/ \E d \in Deps(i) : s[d] = "Help"
Good == \A i \in Issues : Waiting(i)

\* gap rules, written as invariants so a checker can draw the path
HelpNotLost == \A i \in Issues : s[i] = "ClaimedHelp" => (Holds(i) # {} \/ wake)   \* needs-help raised by a worker is always still owed a reap (and so a message to the master)
NoSleepingFrontier == (hb = "paused" /\ ~wake /\ ~owe) => ~Front        \* the heartbeat is never paused while a claimable issue exists and no nudge is owed

\* liveness: automation (workers, maestro, heartbeat, owed nudge) keeps running; people only act when told
\* a tick handles every finished worker, every orphan and every claim, so each reap/requeue/spawn gets its own fairness (one WF over the whole Maestro let it starve W2 forever: a modelling artifact)
Reap(w) == MaestroReapsMerged(w) \/ MaestroReapsHelp(w) \/ MaestroNudgesWorker(w) \/ MaestroGivesUpNudging(w) \/ MaestroRequeuesDied(w)
Fair == Spec /\ WF_vars(Maestro) /\ (\A w \in Workers : WF_vars(Reap(w)) /\ WF_vars(MaestroSpawns(w))) /\ (\A i \in Issues : WF_vars(MaestroRequeuesOrphan(i)) /\ WF_vars(MaestroReapsOrphanHelp(i)) /\ SF_vars(MaestroClaims(i)))
        /\ (\A w \in Workers : WF_vars(WorkerStep(w))) /\ WF_vars(HeartbeatFires) /\ WF_vars(MasterNudges)
\* assumption: a worker that keeps getting started eventually finishes its part (otherwise "workers fail forever + master releases forever" is a trivial livelock)
\* a stall flag has no fairness: it is an alarm the dispatcher may raise, never one it must
FairWin == Fair /\ (\A w \in Workers : SF_vars(WorkerHandsOff(w)) /\ SF_vars(WorkerMerges(w)))
NoSilentStall == []<>Good
====
