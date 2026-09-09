# Compile

Compile native iOS and Android projects.

## Setup

```sh
cd "/path/to/compile"
npm install
```

## Compile a new Expo app

```sh
npx create-expo-app@latest "/path/to/compile/.build/example" --template bare-minimum
cd "/path/to/compile/.build/example"
node "/path/to/compile/dist/cli.js" ios --dev
node "/path/to/compile/dist/cli.js" android --dev
```

## Compile your own app

```sh
cd "/path/to/your/app"
node "/path/to/compile/dist/cli.js" ios --dev
node "/path/to/compile/dist/cli.js" android --dev
```

## CLI

```sh
node "/path/to/compile/dist/cli.js" --help
```

```text
Usage:
  node /path/to/compile/dist/cli.js ios (--dev | --prod) [options]
  node /path/to/compile/dist/cli.js android (--dev | --prod) [options]

Options:
  --dev, --development       Build in development mode
  --prod, --production       Build in production mode
  --device [id]              Build for a generic or specific iOS device
  --output-type <type>       iOS: app or ipa. Android: apk or aab
  --output-dir <path>        Write output files to this directory
  --help                     Show help
```
