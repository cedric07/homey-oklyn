# Homey · Oklyn

Community Homey app for [Oklyn](https://www.oklyn.fr) pool controllers: water quality, filtration, auxiliaries, Flows, and a dashboard widget.

> Independent community project — not affiliated with Oklyn.

[![Homey](https://img.shields.io/badge/Homey-SDK%203-00ADEF)](https://apps.developer.homey.app/)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](./LICENSE)

## Features

- **Measurements**: water / air temperature, pH, ORP (RedOx), salt
- **Filtration**: pump mode Auto / On / Off + running state
- **Auxiliaries**: configurable contacts (switch or regulation)
- **Alerts**: Homey notifications + Flows on warning / danger
- **Widget**: `oklyn-dashboard`
- **i18n**: English and French

## Requirements

- Homey (firmware `>= 12.4.0`)
- An Oklyn controller with access to the [public API](https://api.oklyn.fr/)
- An API key from the Oklyn app: **My Account → API Key**

## Installation

1. Install from the [Homey App Store](https://homey.app/a/com.cedric07.oklyn) or run locally:
   ```bash
   npm install
   homey app run
   ```
2. In Homey: **Apps → Oklyn → Configure**
3. Paste your API key and choose the refresh interval (5 / 10 / 15 min)
4. Add an **Oklyn controller** device

## Usage

| Item | Description |
|------|-------------|
| Device | One Homey device = one Oklyn controller |
| Device settings | Auxiliary mode / labels, notifications |
| Flows | Triggers, conditions, and actions (pump, aux, thresholds, statuses) |
| Widget | Compact metrics view + controls |

## Development

```bash
git clone https://github.com/cedric07/homey-oklyn.git
cd homey-oklyn
npm install
npm run lint
homey app validate --level publish
homey app run
```

### Layout

```
├── app.js
├── lib/OklynApi.js          # Oklyn API client
├── drivers/oklyn/           # Controller driver
├── widgets/oklyn-dashboard/ # Homey widget
├── settings/                # App settings (API key)
├── .homeycompose/           # Manifest + capabilities
└── locales/                 # en / fr
```

## Contributing

Issues and pull requests are welcome:  
https://github.com/cedric07/homey-oklyn/issues

## Support

If this app helps you, you can tip via PayPal:  
https://paypal.me/CedricAndrietti
