# HF2-02 recovery process collection

- Bound product commit: `030f279b21bb603d1545e2920aac5a25ae20d977`
- Collection: `HF2-02-recovery-process`
- Collection digest: `f711ff9d06a5651208f233ea5d7e8216cdf06c5eaf39c6ea41bd47953a4b4af2`
- Result: **PASS**
- Process scenarios: **2/2**
- Recovery-focused Rust tests: **9/9**
- Observed test-only binary SHA-256: `c211167d57afaf8d8d300ce5e266bfee67e17a20aeadfbc346be62b98c1a4c12`

Normal exit produced no recovery dialog. Forced/abnormal exit produced one recovery candidate and restored the exact last-edit scene in 12ms, within the 5-second requirement. Corrupting the newest snapshot selected the next valid snapshot, preserved the on-disk target before the decision, restored the fallback scene, and removed the resolved snapshot ring.

This collection owns process/filesystem recovery facts only. It does not claim browser geometry or visual fidelity, build or launch a production `.app` package, write an independent reviewer verdict, or create a product-owner artifact.
