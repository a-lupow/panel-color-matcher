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
        const addSpinRow = (key, title, subtitle, upper = 100, step = 5) => {
            const row = new Adw.SpinRow({
                title,
                subtitle,
                adjustment: new Gtk.Adjustment({
                    lower: 0,
                    upper,
                    step_increment: step,
                    page_increment: step * 2,
                }),
            });
            settings.bind(key, row, "value", Gio.SettingsBindFlags.DEFAULT);
            group.add(row);

            return row;
        };
        const addPercentRow = (key, title, subtitle) => addSpinRow(key, title, subtitle);
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
        const gradientIntensityRow = addSpinRow("gradient-intensity", "Gradient Intensity",
                                                "How strongly the blurred backdrop is deepened toward the top edge, " +
                                                "in percent of the default; 0 leaves its own colors", 200);
        settings.bind("gradient", gradientIntensityRow, "sensitive", Gio.SettingsBindFlags.GET);
        const gradientSoftnessRow = addPercentRow("gradient-softness", "Gradient Softness",
                                                  "How gently the blurred backdrop levels off into the backdrop " +
                                                  "at the bottom edge, in percent; 0 fades linearly");
        settings.bind("gradient", gradientSoftnessRow, "sensitive", Gio.SettingsBindFlags.GET);
        addPercentRow("brightness-compensation", "Brightness Compensation",
                      "How strongly bright panel colors are darkened and saturated for the white text, in percent");
        addPercentRow("text-contrast", "Text Contrast",
                      "How bright the panel may get before it's darkened, or the text turns dark, in percent");
        addSpinRow("saturation-boost", "Saturation Boost",
                   "How much more saturated the panel color gets than the sampled backdrop, the darker " +
                   "the panel the more, in percent of the default boost; 0 keeps the backdrop's own hue", 200);
        const invertRow = new Adw.SwitchRow({
            title: "Dark Text on Bright Colors",
            subtitle: "Turn the text and symbolic icons black instead of darkening colors " +
                      "too bright for the text contrast above",
        });
        settings.bind("invert-text", invertRow, "active", Gio.SettingsBindFlags.DEFAULT);
        group.add(invertRow);
        const shadowRow = new Adw.SwitchRow({
            title: "Text Shadow",
            subtitle: "Cast a soft dark shadow from the text and icons, stronger the less contrast they have",
        });
        settings.bind("text-shadow", shadowRow, "active", Gio.SettingsBindFlags.DEFAULT);
        group.add(shadowRow);
        const maximizedShadowRow = new Adw.SwitchRow({
            title: "Shadow with Maximized Windows",
            subtitle: "When off, hide the shadow only while a window is maximized or fullscreen",
        });
        settings.bind("maximized-shadow", maximizedShadowRow, "active", Gio.SettingsBindFlags.DEFAULT);
        group.add(maximizedShadowRow);
        const shadowRows = [
            maximizedShadowRow,
            addSpinRow("shadow-distance", "Shadow Distance", "How far down the shadow is cast, in pixels", 8, 1),
            addSpinRow("shadow-radius", "Shadow Radius",
                       "How far out from the text the shadow fades, in pixels; 0 is sharp", 24, 1),
            addPercentRow("shadow-opacity", "Shadow Opacity",
                          "How dark the shadow is next to the text, in percent, where contrast is lowest"),
            addPercentRow("shadow-vibrance", "Shadow Vibrance",
                          "How much the shadow takes a deeper tone of the backdrop instead of neutral dark, in percent"),
        ];

        for (const row of shadowRows) {
            settings.bind("text-shadow", row, "sensitive", Gio.SettingsBindFlags.GET);
        }
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
