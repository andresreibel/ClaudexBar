APP_VERSION := 0.3.0
APP_BUILD := 1
APP_NAME := ClaudexBar
APP_BUNDLE := .build/$(APP_NAME).app
BUN ?= $(shell command -v bun 2>/dev/null)

.PHONY: build check-bun test release icon app open-app install uninstall clean

build:
	swift build

check-bun:
	@test -n "$(BUN)" || (echo "Bun was not found. Install Bun or run make BUN=/path/to/bun." && exit 1)

test: check-bun
	swift test
	$(BUN) test
	$(BUN) build claudexbar.ts --target=bun --outdir .build/bun-check

release:
	swift build -c release

icon:
	mkdir -p .build
	rsvg-convert -w 1024 -h 1024 assets/AppIcon.svg -o .build/AppIcon-1024.png
	rm -rf .build/AppIcon.iconset
	mkdir -p .build/AppIcon.iconset
	sips -z 16 16 .build/AppIcon-1024.png --out .build/AppIcon.iconset/icon_16x16.png >/dev/null
	sips -z 32 32 .build/AppIcon-1024.png --out .build/AppIcon.iconset/icon_16x16@2x.png >/dev/null
	sips -z 32 32 .build/AppIcon-1024.png --out .build/AppIcon.iconset/icon_32x32.png >/dev/null
	sips -z 64 64 .build/AppIcon-1024.png --out .build/AppIcon.iconset/icon_32x32@2x.png >/dev/null
	sips -z 128 128 .build/AppIcon-1024.png --out .build/AppIcon.iconset/icon_128x128.png >/dev/null
	sips -z 256 256 .build/AppIcon-1024.png --out .build/AppIcon.iconset/icon_128x128@2x.png >/dev/null
	sips -z 256 256 .build/AppIcon-1024.png --out .build/AppIcon.iconset/icon_256x256.png >/dev/null
	sips -z 512 512 .build/AppIcon-1024.png --out .build/AppIcon.iconset/icon_256x256@2x.png >/dev/null
	sips -z 512 512 .build/AppIcon-1024.png --out .build/AppIcon.iconset/icon_512x512.png >/dev/null
	sips -z 1024 1024 .build/AppIcon-1024.png --out .build/AppIcon.iconset/icon_512x512@2x.png >/dev/null
	iconutil -c icns .build/AppIcon.iconset -o .build/AppIcon.icns

app: release icon
	rm -rf $(APP_BUNDLE)
	mkdir -p $(APP_BUNDLE)/Contents/MacOS $(APP_BUNDLE)/Contents/Resources
	cp .build/release/claudexbar-macos $(APP_BUNDLE)/Contents/MacOS/ClaudexBar
	cp claudexbar.ts $(APP_BUNDLE)/Contents/Resources/claudexbar.ts
	cp .build/AppIcon.icns $(APP_BUNDLE)/Contents/Resources/AppIcon.icns
	printf '%s\n' \
		'<?xml version="1.0" encoding="UTF-8"?>' \
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
		'<plist version="1.0">' \
		'<dict>' \
		'  <key>CFBundleExecutable</key>' \
		'  <string>ClaudexBar</string>' \
		'  <key>CFBundleIdentifier</key>' \
		'  <string>com.andresreibel.claudexbar</string>' \
		'  <key>CFBundleName</key>' \
		'  <string>ClaudexBar</string>' \
		'  <key>CFBundleDisplayName</key>' \
		'  <string>ClaudexBar</string>' \
		'  <key>CFBundleIconFile</key>' \
		'  <string>AppIcon</string>' \
		'  <key>CFBundlePackageType</key>' \
		'  <string>APPL</string>' \
		'  <key>CFBundleVersion</key>' \
		'  <string>$(APP_BUILD)</string>' \
		'  <key>CFBundleShortVersionString</key>' \
		'  <string>$(APP_VERSION)</string>' \
		'  <key>LSMinimumSystemVersion</key>' \
		'  <string>14.0</string>' \
		'  <key>LSUIElement</key>' \
		'  <true/>' \
		'</dict>' \
		'</plist>' > $(APP_BUNDLE)/Contents/Info.plist
	codesign --force --deep --sign - --identifier com.andresreibel.claudexbar $(APP_BUNDLE)

open-app: app
	open $(APP_BUNDLE)

install: app
	pkill -x ClaudexBar 2>/dev/null || true
	rm -rf /Applications/ClaudexBar.app
	cp -R $(APP_BUNDLE) /Applications/ClaudexBar.app

uninstall:
	pkill -x ClaudexBar 2>/dev/null || true
	rm -rf /Applications/ClaudexBar.app

clean:
	rm -rf .build
