/**
 * The application menu: Electron's default menu, item for item, with every
 * label taken from the interface language. Each item keeps its role, so Edit
 * and Window send the system's standard actions to whatever has focus, and
 * macOS still adds its own Edit items (Emoji & Symbols, Start Dictation) and
 * the list of open windows whatever the menus are titled. The template is pure
 * so a test can read every label it draws.
 */

import { Menu, type MenuItemConstructorOptions } from "electron";
import { APP_NAME } from "../shared/identity.js";
import type { Translator } from "../shared/i18n/translate.js";

export function buildAppMenuTemplate(
  translator: Translator,
  platform: NodeJS.Platform,
): MenuItemConstructorOptions[] {
  const mac = platform === "darwin";
  const l = translator.t;
  return [
    ...(mac
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: "about", label: l("nativeMenu.about", { app: APP_NAME }) },
              { type: "separator" },
              { role: "services", label: l("nativeMenu.services") },
              { type: "separator" },
              { role: "hide", label: l("nativeMenu.hide", { app: APP_NAME }) },
              { role: "hideOthers", label: l("nativeMenu.hideOthers") },
              { role: "unhide", label: l("nativeMenu.showAll") },
              { type: "separator" },
              { role: "quit", label: l("nativeMenu.quit", { app: APP_NAME }) },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: l("nativeMenu.file"),
      submenu: [
        mac
          ? { role: "close", label: l("nativeMenu.closeWindow") }
          : { role: "quit", label: l("nativeMenu.exit") },
      ],
    },
    {
      label: l("nativeMenu.edit"),
      submenu: [
        { role: "undo", label: l("nativeMenu.undo") },
        { role: "redo", label: l("nativeMenu.redo") },
        { type: "separator" },
        { role: "cut", label: l("nativeMenu.cut") },
        { role: "copy", label: l("nativeMenu.copy") },
        { role: "paste", label: l("nativeMenu.paste") },
        ...(mac
          ? ([
              { role: "pasteAndMatchStyle", label: l("nativeMenu.pasteAndMatchStyle") },
              { role: "delete", label: l("nativeMenu.delete") },
              { role: "selectAll", label: l("nativeMenu.selectAll") },
              { type: "separator" },
              {
                label: l("nativeMenu.speech"),
                submenu: [
                  { role: "startSpeaking", label: l("nativeMenu.startSpeaking") },
                  { role: "stopSpeaking", label: l("nativeMenu.stopSpeaking") },
                ],
              },
            ] satisfies MenuItemConstructorOptions[])
          : ([
              { role: "delete", label: l("nativeMenu.delete") },
              { type: "separator" },
              { role: "selectAll", label: l("nativeMenu.selectAll") },
            ] satisfies MenuItemConstructorOptions[])),
      ],
    },
    {
      label: l("nativeMenu.view"),
      submenu: [
        { role: "reload", label: l("nativeMenu.reload") },
        { role: "forceReload", label: l("nativeMenu.forceReload") },
        { role: "toggleDevTools", label: l("nativeMenu.toggleDevTools") },
        { type: "separator" },
        { role: "resetZoom", label: l("nativeMenu.actualSize") },
        { role: "zoomIn", label: l("nativeMenu.zoomIn") },
        { role: "zoomOut", label: l("nativeMenu.zoomOut") },
        { type: "separator" },
        { role: "togglefullscreen", label: l("nativeMenu.fullscreen") },
      ],
    },
    {
      role: "windowMenu",
      label: l("nativeMenu.window"),
      submenu: [
        { role: "minimize", label: l("nativeMenu.minimize") },
        { role: "zoom", label: l("nativeMenu.zoom") },
        ...(mac
          ? ([
              { type: "separator" },
              { role: "front", label: l("nativeMenu.bringAllToFront") },
            ] satisfies MenuItemConstructorOptions[])
          : ([{ role: "close", label: l("nativeMenu.close") }] satisfies MenuItemConstructorOptions[])),
      ],
    },
    { role: "help", label: l("nativeMenu.help"), submenu: [] },
  ];
}

/** Replaces the application menu with one in the translator's language. */
export function installAppMenu(translator: Translator): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate(translator, process.platform)));
}
