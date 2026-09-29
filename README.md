# AQW Wiki Gaze

A userscript that shows a preview when you hover a link on the [AQW Wiki](https://aqwwiki.wikidot.com). You can check an item's image, rarity and stats without opening the page or losing your place.

## What the preview shows

- **Name and images** of the linked page (up to two).
- **Availability badges:** AC, Rare, Pseudo-Rare, Seasonal, Special Offer, Legend and NO IoDA.
- **Damage range** with its class: Default, Fixed, High, Medium or Other.
- **Boosts with their value:** Gold, XP, Class Points and Reputation, plus damage bonuses against Chaos, Dragon, Drakath, Elemental, Human, Orc, Undead or all monsters.

## Where it works

It works on any link inside wiki pages, in the shop and inventory tables, and in the recent changes list. Pages that are not items (worlds, events, factions, quests, shops and similar) show badges but no image.

## Install

1. Install a userscript manager such as [Violentmonkey](https://violentmonkey.github.io/) or Tampermonkey.
2. Open [`aqw-wiki-gaze.user.js`](https://raw.githubusercontent.com/soyquetzal/aqw-wiki-gaze/main/aqw-wiki-gaze.user.js) and confirm the install.

Updates are picked up automatically by your userscript manager.

## How it behaves

- Previews appear after a short hover delay, so moving the cursor across a page does not trigger requests.
- Pages you have already previewed are cached for the tab, so they show instantly and survive navigating between wiki pages.
- Requests are rate limited, and the script backs off if the wiki responds with an error or asks it to slow down. It only reads public pages and sends no cookies.

## Known limitations

- Damage ranges and boosts are read from the page text, so pages with unusual wording may show a badge without its value, or none at all. Reports of pages that fail are welcome in the [issues](https://github.com/soyquetzal/aqw-wiki-gaze/issues).
- Hover only. There is no touch support.

## License

MIT
