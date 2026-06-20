# UXP API Reference Notes for Extended Template Tools

These notes summarize docs-level API research for the remaining editable-layout template tools. They are not a substitute for live InDesign/UXP probes.

## Sources

- InDesign UXP DOM versioning: https://developer.adobe.com/indesign/uxp/resources/fundamentals/dom-versioning/
- ExtendScript-to-UXP migration notes: https://developer.adobe.com/indesign/uxp/resources/migration-guides/extendscript/
- InDesign DOM API reference: https://developer.adobe.com/indesign/dom/api/
- Document APIs: https://developer.adobe.com/indesign/dom/api/d/Document/
- Text API: https://developer.adobe.com/indesign/dom/api/t/Text/
- TextFrame API: https://developer.adobe.com/indesign/dom/api/t/TextFrame/
- Rectangle API: https://developer.adobe.com/indesign/dom/api/r/Rectangle/
- Paragraph and character style collections: https://developer.adobe.com/indesign/dom/api/p/ParagraphStyles/ and https://developer.adobe.com/indesign/dom/api/c/CharacterStyles/
- Object styles: https://developer.adobe.com/indesign/dom/api/o/ObjectStyles/
- Swatches and colors: https://developer.adobe.com/indesign/dom/api/s/Swatches/ and https://developer.adobe.com/indesign/dom/api/c/Color/
- Fit, align, and distribute enums: https://developer.adobe.com/indesign/dom/api/f/FitOptions/, https://developer.adobe.com/indesign/dom/api/a/AlignOptions/, https://developer.adobe.com/indesign/dom/api/d/DistributeOptions/, https://developer.adobe.com/indesign/dom/api/a/AlignDistributeBounds/
- Groups: https://developer.adobe.com/indesign/dom/api/g/Groups/
- Layers: https://developer.adobe.com/indesign/dom/api/l/Layers/

## Verified usage patterns

- UXP snippets should use `require("indesign")` for enums such as `FitOptions`, `AlignOptions`, `DistributeOptions`, and `AlignDistributeBounds`.
- InDesign collections should use `.item(i)` or `.itemByName(name)`, not bracket access.
- Style lookup pattern: `const style = doc.paragraphStyles.itemByName(name); if (!style.isValid) ...`.
- Paragraph style on a whole text frame: `item.texts.item(0).applyParagraphStyle(style, false)`.
- Character style on a whole text frame: `item.texts.item(0).applyCharacterStyle(style)`.
- Object style on page items: `item.applyObjectStyle(style, false, false)`.
- Swatches should usually come from `doc.swatches.itemByName(name)` so built-ins like `None`, `Paper`, and `Black` can work alongside normal colors.
- Object color properties: `item.fillColor`, `item.strokeColor`, `item.strokeWeight`.
- Text color properties can be applied to `item.texts.item(0)` with `fillColor`, `strokeColor`, and likely `strokeWeight` where supported.
- Image placement on an existing frame is expected to be `frame.place(pathOrFile, false)`, followed by optional `frame.fit(FitOptions.FILL_PROPORTIONALLY)` or similar.
- Fit methods: `frame.fit(FitOptions.CONTENT_TO_FRAME)`, `FitOptions.FRAME_TO_CONTENT`, `FitOptions.PROPORTIONALLY`, `FitOptions.FILL_PROPORTIONALLY`, `FitOptions.CENTER_CONTENT`.
- Z-order methods: `item.bringToFront()` and `item.sendToBack()`.
- Grouping pattern: `parent.groups.add(items)` and `group.ungroup()`.
- Native alignment/distribution exists on documents: `doc.align(items, AlignOptions.LEFT_EDGES, AlignDistributeBounds.ITEM_BOUNDS, reference)` and `doc.distribute(...)`.
- Reference underlays should use a dedicated layer with `layer.printable = false`, plus `rect.nonprinting = true`, then lock the layer after placement if desired.

## Recommended implementation order

1. `bring_to_front`, `send_to_back`, `fit_content_to_frame`, `fit_frame_to_content`.
2. `apply_swatches`.
3. `apply_styles`.
4. `place_image` after one file/path probe.
5. `group_items`, `ungroup_items`.
6. `align_items`, `distribute_items`.
7. Reference underlay tools.

## Live-probe risks

- Whether `frame.place(pathString)` works reliably through this UXP bridge or needs a UXP `File` object.
- Exact built-in swatch names in the target locale/version.
- Whether `doc.align`, `doc.distribute`, and `groups.add` accept plain JavaScript arrays of page items in UXP.
- Whether defaulting style application to `clearingOverrides = false` preserves the desired template-local tweaks.
