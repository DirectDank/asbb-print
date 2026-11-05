# ASBB Print

Free label printing for the **Phomemo PM-241-BT** (and other TSPL thermal label printers), straight from your phone. No app store, no account, no subscription. By [All Sorts by Ben](https://allsortsbyben.co.uk).

## What it does
- **Shipping labels with auto-crop**: open or share an eBay, Vinted, Royal Mail or Evri PDF or screenshot; ASBB Print finds the label, rotates and fits it to 4×6 (or any size), then prints. "Try next area" and "Adjust crop" fix the odd awkward page.
- **Label designer**: text, logos, pictures, QR codes, barcodes, boxes and lines. Print one label per row from a CSV spreadsheet, or add auto-numbering with `{{n}}`.
- **Saved projects** with one-tap reprint, pinning, search, and backup/restore to a file.
- **Packing slip** built in, and can print automatically after each label.
- Installs to your home screen, works offline, and appears in Android's share menu.
- Everything stays on your device. Nothing is uploaded.

## Works with
- Chrome on Android (148 or newer) and Chrome or Edge on a computer.
- Bluetooth Classic printers via Web Serial (PM-241-BT), Bluetooth LE printers, and USB (WebUSB).
- iPhone/iPad browsers can't connect to Bluetooth printers.

## First time
1. Pair the printer in your phone's Bluetooth settings (it shows as `PM-241…`).
2. Open ASBB Print, tap **Connect printer → Connect Bluetooth printer** and choose it.
3. Tap **Test print**. The bar should print solid black. If it prints white-on-black, tick "negative" in Settings; if it's upside down, tick "flip".

## Hosting
Plain static files. GitHub Pages: Settings → Pages → deploy from branch `main`, folder `/`.

## Licences
App code © All Sorts by Ben, MIT licence. Includes PDF.js (Apache 2.0), JsBarcode (MIT) and qrcode-generator (MIT). The ASBB name and logo are trademarks of All Sorts by Ben and are not covered by the MIT licence.
