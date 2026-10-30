// -*- coding: utf-8-unix -*-

import Adw from "gi://Adw";
import Gio from "gi://Gio";
import Gtk from "gi://Gtk";

import {ExtensionPreferences} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

export default class PanelColorMatcherPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup();
        const addPercentRow = (key, title, subtitle) => {
            const row = new Adw.SpinRow({
                title,
                subtitle,
                adjustment: new Gtk.Adjustment({
                    lower: 0,
                    upper: 100,
                    step_increment: 5,
                    page_increment: 10,
                }),
            });
            settings.bind(key, row, "value", Gio.SettingsBindFlags.DEFAULT);
            group.add(row);

            return row;
        };
        addPercentRow("opacity", "Opacity", "Panel background opacity in percent");
        addPercentRow("maximized-opacity", "Opacity with Maximized Windows",
                      "Panel background opacity in percent while a window is maximized or fullscreen");
        const gradientRow = new Adw.SwitchRow({
            title: "Gradient",
            subtitle: "Fade the background from the opacity above at the top to the opacity below at the bottom, " +
                      "except while a window is maximized or fullscreen",
        });
        settings.bind("gradient", gradientRow, "active", Gio.SettingsBindFlags.DEFAULT);
        group.add(gradientRow);
        const gradientOpacityRow = addPercentRow("gradient-opacity", "Gradient Bottom Opacity",
                                                 "Panel background opacity in percent at the bottom edge");
        settings.bind("gradient", gradientOpacityRow, "sensitive", Gio.SettingsBindFlags.GET);
        const compensateRow = new Adw.SwitchRow({
            title: "Compensate Brightness",
            subtitle: "Darken the panel color as opacity decreases",
        });
        settings.bind("compensate-brightness", compensateRow, "active", Gio.SettingsBindFlags.DEFAULT);
        group.add(compensateRow);
        addPercentRow("text-contrast", "Text Contrast",
                      "How strongly bright colors are darkened for the white text, in percent");
        const accentRow = new Adw.SwitchRow({
            title: "Accent Color from Wallpaper",
            subtitle: "Set the system accent color to the closest match to the wallpaper",
        });
        settings.bind("wallpaper-accent", accentRow, "active", Gio.SettingsBindFlags.DEFAULT);
        group.add(accentRow);
        const debugRow = new Adw.SwitchRow({
            title: "Debug Logging",
            subtitle: "Log sampled colors to the system journal",
        });
        settings.bind("debug", debugRow, "active", Gio.SettingsBindFlags.DEFAULT);
        group.add(debugRow);
        page.add(group);
        window.add(page);
    }

}
