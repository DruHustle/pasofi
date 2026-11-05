# PasoFi Home lifestyle assets

Created for the PasoFi home-page redesign on 2026-11-05 using the built-in image-generation tool. These are illustrative fictional lifestyle scenes, not customer testimonials or documentary photographs. No input images, third-party logos, or Vodacom assets were used.

The deployed WebP files preserve the complete 1536 × 1024 generated compositions. Conversion used quality 84, method 6, with no crop or content edits. The two delivered web images total less than 330 KB.

| Asset | SHA-256 | Bytes |
| --- | --- | --- |
| `pasofi-community-hero.webp` | `410930d359b6eb486d2f536a1ba1841c02b7026c3ae4cefadd7e38c038eabf3e` | 179352 |
| `pasofi-study-together.webp` | `d60e33b2f412696057dbe3cc4e945d6cbcf67ab787539332b72237b02f3065fa` | 146030 |

## Creative direction

People-focused editorial photography, vivid natural color, blue close to `#075cf5`, navy `#092451`, white and restrained lime `#e5ff52`; natural skin and material textures; no logos, text, watermarks or readable screens.

The community hero shows three clearly adult Black Zimbabwean friends sharing a smartphone in a bright modern neighbourhood courtyard, with clean stucco and green plants. One wears a blue overshirt; the others wear cream and navy, with a small lime accessory. The group is composed centrally/right for responsive cropping, with faces and hands kept inside the image.

The second photo shows two clearly adult Black African students collaborating at a laptop in a bright, uncluttered workspace. The scene uses natural smiles, soft daylight, blue/navy/white clothing and a small lime accessory. The laptop screen is not legible.

The site uses the pictures as visual storytelling. Product prices, allowances, availability and customer actions continue to come from the live application state.

## Exact generation prompts

Built-in imagegen was used with `transparent_background: false` and no reference images. Each asset was generated in a separate tool call.

### pasofi-community-hero

```text
Use case: photorealistic-natural
Asset type: premium telecom website lifestyle hero photograph, landscape 3:2.
Primary request: Three joyful Black Zimbabwean young adults, all clearly adults, casually sharing a smartphone in a bright contemporary neighbourhood courtyard. Candid, warm, natural interaction; believable real people rather than exaggerated posed advertising smiles.
Scene/backdrop: clean light stucco courtyard, a few lush green plants, contemporary everyday neighbourhood, uncluttered.
Subject: exactly three friends gathered together looking at the smartphone, natural individual faces, one wearing a royal-blue overshirt and the others cream and navy attire; one subtle lime-green accessory.
Composition/framing: group occupies centre and right of the landscape frame, enough calm courtyard background on left; waist-up to mid-thigh group framing; keep all faces and the phone comfortably inside the frame for responsive cropping.
Lighting/mood: bright soft daylight, authentic skin texture, uplifting premium editorial campaign photography, vivid but natural colour, realistic camera optics.
Color palette: royal blue close to #075cf5, navy #092451, cream and white, one small lime #e5ff52 accent, green plants.
Constraints: anatomically sound faces, hands and fingers; plausible smartphone grip. No logos, no text, no watermarks, no readable phone screen, no brand signage. One finished photograph, not a collage or website mockup.
```

### pasofi-study-together

```text
Use case: photorealistic-natural
Asset type: premium telecom website secondary lifestyle photograph, landscape 3:2.
Primary request: Two Black African adult students collaborating on a laptop in a bright, airy contemporary study workspace, with warm natural smiles and a believable candid interaction.
Scene/backdrop: light clean workspace with pale walls, broad soft window daylight, modest contemporary desk, calm uncluttered surroundings.
Subject: exactly two clearly adult students seated together at the laptop, distinct people from a typical courtyard scene; blue, navy and white casual clothing and one small lime-green accessory. The laptop is central to their shared activity; natural body language.
Composition/framing: intimate medium-wide landscape composition showing both faces, some torso and desk, laptop angled so the screen is not legible; keep faces and hands clear and complete, adaptable to responsive crop.
Lighting/mood: warm soft daylight, photorealistic skin and material textures, vivid natural colour, premium editorial lifestyle campaign photography.
Color palette: blue close to #075cf5, navy #092451, white, a restrained lime #e5ff52 accent.
Constraints: anatomically sound faces, hands and fingers; believable hands near laptop. No logos, no text, no watermarks, no readable screen or labels. One finished photograph, not a collage or website mockup.
```

