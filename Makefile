# -*- coding: utf-8-unix -*-

EXTENSION := panel-color-matcher@otsaloma.io
PACK_FILE := $(EXTENSION).shell-extension.zip
INSTALL_DIR := ~/.local/share/gnome-shell/extensions/$(EXTENSION)

check:
	jshint *.js
	gjs -m test.js

clean:
	rm -f $(PACK_FILE)

install:
	mkdir -p $(INSTALL_DIR)
	cp -f color.js $(INSTALL_DIR)
	cp -f extension.js $(INSTALL_DIR)
	cp -f metadata.json $(INSTALL_DIR)
	cp -f prefs.js $(INSTALL_DIR)
	mkdir -p $(INSTALL_DIR)/schemas
	cp -f schemas/*.gschema.xml $(INSTALL_DIR)/schemas
	glib-compile-schemas $(INSTALL_DIR)/schemas

pack:
	$(MAKE) check clean
	gnome-extensions pack --extra-source=color.js

run:
	dbus-run-session gnome-shell --devkit --wayland

.PHONY: check clean install pack run
