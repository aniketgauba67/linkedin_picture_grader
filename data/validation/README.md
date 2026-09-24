# LinkedIn profile picture validation set (125 real photographs)

## Purpose and labels
This dataset tests whether a model distinguishes the usefulness of a photograph as a *small circular LinkedIn profile avatar*. GOOD (40) is a picture I would confidently recommend; MEDIUM (45) is usable but has a meaningful framing, lighting, pose, or contextual weakness; BAD (40) should be replaced for this particular use. Labels concern **photographs, never the worth or professionalism of the people pictured**. Demographic traits were not labeling criteria.

## Selection
Photographs came from Wikimedia Commons file pages and were downloaded at Commons' standard thumbnail sizes, visually reviewed on numbered contact sheets, then independently assigned suitability labels. Search metadata alone did not determine labels. Images with non-human content, uncertain machine-readable licenses, or obvious duplication were excluded. Selected copies were converted to JPEG while preserving framing (no artificial blur, relighting, or generated faces). Filename prefixes and folders give the label. The `variation_group` describes the visual issue or strength for benchmarking, not a fixed taxonomy of people.

## Sources and licensing
Every image has a source page, original filename, author field as available, machine-readable Commons license, and license URL in `sources.csv`. Commons hosts public-domain/CC0 and various CC BY / CC BY-SA files; each photograph retains its own license, and attribution or ShareAlike terms may apply to your redistribution or adaptations. Consult each linked file page before external publication, especially where a public-domain status is jurisdiction-dependent. The JPGs are resized or format-converted copies; `direct_image_url_if_available` points to the source original, while the source page contains current licensing and attribution details. Commons' per-file information remains authoritative.

## Distribution
GOOD 40; MEDIUM 45; BAD 40; total 125. `labels.csv` contains image-level judgments and photographic features; `sources.csv` contains provenance. Both match the folder filenames.

## Limitations
This is a small, judgment-labeled challenge set, not a representative population sample, and it is not calibrated to LinkedIn engagement or hiring outcomes. Commons category coverage and license-filtered sampling create subject, era, camera, geography, and profession biases. Some archival photos intentionally test framing failures, but should not be read as current portraits. Counts of visible people are approximate when background people are present. Photos are 330–960-pixel source thumbnails or smaller originals, then converted to JPEG; compression and historical scan quality vary. The labels should be manually validated for your model's target audience and crop behavior. Do not use these labels to assess a person's qualifications or protected attributes.

## Four-axis calibration labels
`data/calibration-labels.csv` has exactly four rows per image: `sharpness`, `lighting`, `resolution`, and `framing`, scored 1–5 using the supplied calibration anchors. These scores are independent of the overall GOOD/MEDIUM/BAD judgment. Adjacent-score ties go to the lower score. Sharpness refers to visible facial/eye detail rather than background focus; an obstruction itself was not treated as blur. For group images, technical face assessments refer to the most prominent visible face, while framing reflects whether that face is usefully positioned in the whole delivered image. Lighting addresses facial exposure, and framing ignores attire and context. Resolution describes the JPEG copy in this package at profile-display size; it is not a claim about a higher-resolution source original.
