# HR Voice Interviews: Netlify + DialNexa

## Deploy (one time)
1. Install Node 18+. In this folder: `npm install`
2. `npx netlify-cli login`
3. `npx netlify-cli init` (create a new site, no GitHub needed) or `npx netlify-cli link` to use an existing one
4. In Netlify: Site configuration > Environment variables. Add:
   - `ADMIN_PASSWORD` : dashboard password (required online)
   - `DIALNEXA_API_KEY` : DialNexa API key (`key_id:secret`)
   - `DIALNEXA_AGENT_ID` : your published DialNexa agent id (`agent_...`)
   - `DIALNEXA_WEBHOOK_SECRET` : from DialNexa step 5 below
   - `DIALNEXA_PHONE_NUMBER_ID` : optional, only if the agent has several outbound numbers
5. `npx netlify-cli deploy --prod`

## DialNexa setup
1. Workspace settings > Developer > Signing secrets > **+ New secret**. Copy it into `DIALNEXA_WEBHOOK_SECRET` (step 4 above), then redeploy.
2. Webhooks tab > add `https://YOUR-SITE.netlify.app/webhook/dialnexa`. It must return 2xx to the check, so deploy first.
3. Open your agent > attach that webhook, then **Publish** again.
4. Agent > Post-Call Analysis: add fields named `summary`, `answers`, `notice_period`, `expected_ctc`, `score_1_to_10`, `recommendation`. Other fields are shown too.
5. Workspace Settings > Telephony: enable India (+91). Add wallet balance. Until KYC is approved, DialNexa only lets you call the owner's own number.

## Notes
- Recordings: DialNexa links expire after 7 days, so each recording is copied into Netlify Blobs when the call ends.
- "Call all pending" is run from the browser, one candidate at a time. Keep the tab open until it finishes.
- Calls are billable and are never retried automatically.
- Test locally without Netlify: `node tests/run.mjs`
