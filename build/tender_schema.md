# Tender transcription schema

One JSON file per tender: `build/tender_ai/<nid>.json`. Read every document listed for the tender in
`build/tenders_index.json` (notice + corrigenda). Use the text layer in `build/tender_text/<nid>/<file>.txt`;
for pages listed in `build/tender_prep.json` as `scanned_pages`, look at
`build/tender_pages/<nid>/<file>-<page>.png` (Read the PNG: Claude vision). Hindi pages: read them too,
record English values. Never invent: use null when a value is not printed.

Privacy: record offices and designations only. Replace personal mobile numbers and personal e-mail
addresses with "[personal contact removed]". Official landlines and office e-mail may be kept.

```json
{
  "nid": 2587,
  "title": "official title as printed in the notice",
  "summary": "One or two plain sentences: what is being bought or built, where.",
  "category": "civil works | electrical works | AtoN equipment | equipment supply | IT & communications | vessels & vehicles | services & maintenance | consultancy & surveys | disposal & auction | heritage & tourism | other",
  "procurement": {
    "mode": "open tender | limited tender | single tender | GeM bid | NIQ / quotation | e-auction | EOI | other",
    "portal": "CPPP eprocure | GeM | offline | other | null",
    "reference": "tender / NIT / GeM bid numbers verbatim, ';'-separated",
    "issuing_office": "e.g. Directorate of Lighthouses and Lightships, Chennai"
  },
  "scope_level": "sites | directorate | national",
  "sites": [
    {"name": "as printed", "station_id": "id from build/station_names.tsv or null", "kind": "lighthouse | light vessel | DGNSS | NAVTEX | VTS | RACON | AIS | office | depot | other", "work": "short description of the work at this site"}
  ],
  "scope": [
    {"item": "item of work / supply as printed (trim boilerplate)", "qty": "string or null", "unit": "string or null", "site": "site name or null"}
  ],
  "money": {
    "estimated_cost_inr": 1234567.0,
    "emd_inr": null,
    "tender_fee_inr": null,
    "performance_security": "e.g. 3% of contract value, or null",
    "notes": "e.g. EMD exempt for MSEs; cost inclusive of GST; or null"
  },
  "period": {"completion": "e.g. 90 days from work order", "bid_validity": null, "warranty": null},
  "dates": {"published": "YYYY-MM-DD", "pre_bid": null, "bid_submission_end": null, "bid_opening": null},
  "eligibility": ["short bullet per criterion: turnover, experience, registration class …"],
  "specs": ["notable technical specs: makes, models, standards, capacities"],
  "corrigenda": [{"date": "YYYY-MM-DD or null", "change": "what changed"}],
  "documents": [
    {"file": "NIT_3.pdf", "pages": 12, "read": "text | vision | mixed", "language": "en | hi | bilingual", "unreadable": ["page 7 stamp illegible"]}
  ],
  "confidence": "high | medium | low",
  "notes": "anything odd: mismatched dates, missing BOQ, title differs from document, etc."
}
```

`station_id` must be copied exactly from `build/station_names.tsv` (id, name, directorate, alternate
spellings). Match spelling variants (Portonova = Porto Novo, Kanyakumari = Cape Comorin, Vypeen = Vypin).
Sites that are not on that list (depots, offices, decommissioned lights) keep `station_id: null`.
For tenders covering "all lighthouses under X directorate" without naming them, use
`scope_level: "directorate"` and leave `sites` empty unless the BOQ names individual stations.
