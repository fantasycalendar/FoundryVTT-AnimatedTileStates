import CONSTANTS from "./constants.js";
import { TileInterface } from "./tile-interface/tile-interface.js";
import * as lib from "./lib/lib.js";
import { getSceneDelegator, isRealNumber } from "./lib/lib.js";
import SocketHandler from "./socket.js";
import { get, writable } from "svelte/store";

const tileHudMap = new Map();
const managedStatefulTiles = new Map();
let currentDelegator = false;
let delegateDebounce = false;

export const copiedData = writable(false);
const hudScale = writable(0);

export class StatefulTile {

  constructor(document, texture) {
    this.document = document;
    this.uuid = this.document.uuid;
    this.flags = new Flags(this.document);
    this.offset = this.flags.offset;
    this.texture = texture;
    this.video = this.texture.baseTexture.resource.source;
    this.timeout = false;
    this.still = false;
    this.nextButton = false;
    this.prevButton = false;
    this.select = false;
    this.newCurrentTime = null;
    this.ready = !!currentDelegator;
  }

  static setAllReady() {
    this.getAll().forEach(tile => {
      if (!tile.ready) {
        tile.ready = true;
        tile.flags.updateData();
        game.video.play(tile.video);
      }
    });
  }

  static determineCurrentDelegator() {

    if (delegateDebounce) delegateDebounce();

    delegateDebounce = foundry.utils.debounce(async () => {

      // When you first render a scene, determine which user should be the delegator
      const newDelegator = getSceneDelegator();

      // If the user isn't the delegator, they should clear their own info to avoid confusion
      if (!game.user.isGM && newDelegator !== game.user && lib.isGMConnected()) {
        await game.user.unsetFlag(CONSTANTS.MODULE_NAME, CONSTANTS.FLAG_KEYS.DELEGATED_TILES);
      }

      // If the delegator has changed to a non-GM, and the new delegator is you, whilst there are no GMs connected
      if (newDelegator !== currentDelegator && !newDelegator.isGM && newDelegator === game.user && !lib.isGMConnected()) {

        // Grab all tile's current state
        let updates = {};
        StatefulTile.getAll().forEach(tile => {
          updates[CONSTANTS.DELEGATED_TILES_FLAG + "." + tile.delegationUuid] = tile.flags.getData();
        });

        currentDelegator = newDelegator;

        // Store the tile's current state on yourself
        await game.user.update(updates);

      }

      currentDelegator = newDelegator;

      StatefulTile.setAllReady();

    }, 100);

  }

  static registerHooks() {

    Hooks.on('userConnected', () => {
      this.determineCurrentDelegator();
    });

    Hooks.on('getSceneNavigationContext', () => {
      this.determineCurrentDelegator();
    });

    let firstUpdate = true;
    Hooks.on('updateUser', (user, data) => {

      // If the user wasn't updated with delegated tiles, exit
      if (!hasProperty(data, CONSTANTS.DELEGATED_TILES_FLAG)) return;

      // If they were, but it was removed, exit
      const updatedTiles = getProperty(data, CONSTANTS.DELEGATED_TILES_FLAG);
      if (!updatedTiles) return;

      // If the current delegator is a GM, don't do anything, they will handle updates
      if (currentDelegator.isGM) return;

      // Otherwise, loop through each of the updated tiles
      Object.keys(updatedTiles).forEach(key => {
        // Get the stateful tile based on the UUID that was updated on the user
        const [sceneId, tileId] = key.split("_");
        const tile = StatefulTile.get(`Scene.${sceneId}.Tile.${tileId}`);
        if (!tile) return;
        // Call the update method, and pass the user that is the current delegator
        StatefulTile.onUpdate(
          tile.document,
          // Construct a similar diff as normal tile updates would create
          foundry.utils.mergeObject({
            [CONSTANTS.FLAGS]: updatedTiles[key]
          }, {}),
          firstUpdate
        );
      });
      firstUpdate = false;
    });

    Hooks.on("renderTileHUD", (app, html) => {
      tileHudMap.set(app.object.document.uuid, app);
      StatefulTile.renderTileHUD(app, html);
    });

    Hooks.on("preUpdateTile", (tileDoc, data) => {
      StatefulTile.onPreUpdate(tileDoc, data);
    });

    Hooks.on("updateTile", (tileDoc, data) => {
      StatefulTile.onUpdate(tileDoc, data);
    });

    Hooks.on("createTile", (tileDoc) => {
      const path = lib.getTileJsonPath(tileDoc);
      fetch(path)
        .then(response => response.json())
        .then((result) => {
          tileDoc.update(result);
        })
        .catch(err => {
        });
    });

    Hooks.on("canvasReady", () => {
      hudScale.set(canvas.stage.scale.x);
      setTimeout(() => {
        for (const placeableTile of canvas.tiles.placeables) {
          if (!placeableTile.isVideo || !getProperty(placeableTile.document, CONSTANTS.STATES_FLAG)?.length) continue;
          const tile = StatefulTile.make(placeableTile.document, placeableTile.texture);
          if (!tile) return;
          if (game?.video && tile.video) {
            game.video.play(tile.video);
          }
        }
      }, 200);
    })

    Hooks.on("canvasPan", () => {
      hudScale.set(canvas.stage.scale.x);
    });

    hudScale.subscribe(() => {
      StatefulTile.getAll().forEach(tile => tile.updateHudScale());
    });

    const refreshDebounce = foundry.utils.debounce((tile) => {
      if (game?.video && tile.video) {
        game.video.play(tile.video);
      }
    }, 200);

    Hooks.on("refreshTile", (placeableTile) => {
      if (!placeableTile.isVideo || !getProperty(placeableTile.document, CONSTANTS.STATES_FLAG)?.length) return;
      const tile = StatefulTile.make(placeableTile.document, placeableTile.texture);
      if (!tile) return;
      tile.evaluateVisibility();
      refreshDebounce(tile);
    });

  }

  static getAll() {
    return managedStatefulTiles;
  }

  static get(uuid) {
    return managedStatefulTiles.get(uuid) || false;
  }

  static make(document, texture) {
    const existingTile = this.get(document.uuid);
    if (!existingTile?.app || existingTile?.app?._state <= Application.RENDER_STATES.CLOSED) {

    }
    if (existingTile) return existingTile;
    const newTile = new this(document, texture);
    managedStatefulTiles.set(newTile.uuid, newTile);
    if (currentDelegator) {
      newTile.flags.updateData();
    }
    return newTile;
  }

  get duration() {
    return this.video.duration * 1000;
  }

  static tearDown(uuid) {
    const tile = StatefulTile.get(uuid);
    if (!tile) return;
    if (tile.timeout) clearTimeout(tile.timeout);
    managedStatefulTiles.delete(uuid);
  }

  static makeHudButton(tooltip, icon, style = "") {
    return $(`<div class="ats-hud-control-icon ats-tile-ui-button" style="${style}" data-tooltip-direction="UP" data-tooltip="${tooltip}">
      <i class="fas ${icon}"></i>
    </div>`);
  }

  /**
   * Adds additional control elements to the tile HUD relating to Animated Tile States
   *
   * @param app
   * @param html
   */
  static renderTileHUD(app, html) {

    const tileDocument = app.object.document;
    const tile = StatefulTile.get(app.object.document.uuid);

    const root = $("<div class='ats-hud'></div>");

    const controlsContainer = $("<div class='ats-hud-controls-container'></div>")

    const configButton = StatefulTile.makeHudButton("Configure Tile States", "the-kinemancer-icon", "margin-right: 40px;");

    configButton.on('pointerdown', () => {
      TileInterface.show(tileDocument);
    });

    controlsContainer.append(configButton);

    root.append(controlsContainer);

    if (tile) {

      const fastPrevButton = StatefulTile.makeHudButton("Go To Previous State", "fas fa-backward-fast");
      const prevButton = StatefulTile.makeHudButton("Queue Previous State", "fas fa-backward-step");
      const nextButton = StatefulTile.makeHudButton("Queue Next State", "fas fa-step-forward");
      const fastNextButton = StatefulTile.makeHudButton("Go To Next State", "fas fa-fast-forward", "margin-right: 40px;");

      fastPrevButton.on('pointerdown', () => {
        tile.changeState({ step: -1, fast: true });
      });

      prevButton.on('pointerdown', () => {
        tile.changeState({ step: -1 });
      });

      nextButton.on('pointerdown', () => {
        tile.changeState();
      });

      fastNextButton.on('pointerdown', () => {
        tile.changeState({ fast: true });
      });

      const copyButton = StatefulTile.makeHudButton("Copy", "fas fa-copy");
      const pasteButton = StatefulTile.makeHudButton("Paste", "fas fa-paste");

      copyButton.on('pointerdown', () => {
        tile.flags.copyData();
      });

      pasteButton.on('pointerdown', () => {
        tile.flags.pasteData();
      });

      controlsContainer.append(fastPrevButton)
      controlsContainer.append(prevButton)
      controlsContainer.append(nextButton)
      controlsContainer.append(fastNextButton)
      controlsContainer.append(copyButton)
      controlsContainer.append(pasteButton)

      const selectContainer = $("<div class='ats-hud-select-container'></div>");

      for (const [index, state] of tile.flags.states.entries()) {
        if (!state.icon) continue;
        const stateBtn = StatefulTile.makeHudButton(state.name, state.icon);
        stateBtn.on("pointerdown", () => {
          tile.changeState({ state: index, fast: true });
        });
        selectContainer.append(stateBtn);
      }

      const select = $("<select class='ats-tile-ui-button'></select>");
      select.on('change', function () {
        tile.changeState({ state: Number($(this).val()), fast: true });
      });

      for (const [index, state] of tile.flags.states.entries()) {
        select.append(`<option ${index === tile.flags.currentStateIndex ? "selected" : ""} value="${index}">${state.name}</option>`);
      }

      const tileColor = lib.determineFileColor(tile.document.texture.src);

      const selectButtonContainer = $("<div></div>");

      const selectColorButton = $(`<div class="ats-hud-control-icon ats-tile-ui-button" data-tooltip-direction="UP" data-tooltip="Change Tile Color">
      ${tileColor.icon ? `<i class="fas ${tileColor.icon}"></i>` : ""}
      ${tileColor.color ? `<div class="ats-color-button" style="${tileColor.color}"></div>` : ""}
    </div>`);

      const selectColorContainer = $(`<div class="ats-color-container"></div>`);

      const baseFile = decodeURI(tile.document.texture.src).split("  ")[0].replace(".webm", "") + "*.webm";
      lib.getWildCardFiles(baseFile).then((results) => {
        const width = results.length * 34;
        selectColorContainer.css({ left: width * -0.33, width });
        for (const filePath of results) {
          const { colorName, color } = lib.determineFileColor(filePath);
          const button = $(`<div class="ats-color-button" style="${color}"></div>`)
          if (!colorName) {
            selectColorContainer.prepend(button);
          } else {
            selectColorContainer.append(button);
          }
          button.on("pointerdown", async () => {
            selectColorButton.html(`<div class="ats-color-button" style="${color}"></div>`);
            selectColorButton.trigger("pointerdown");
            tile.document.update({
              img: filePath
            });
          });
        }
      });

      selectColorButton.on('pointerdown', () => {
        const newState = selectColorContainer.css('visibility') === "hidden"
          ? "visible"
          : "hidden";
        selectColorContainer.css("visibility", newState);
      });

      selectButtonContainer.append(selectColorButton);
      selectButtonContainer.append(selectColorContainer);

      selectContainer.append(select);
      selectContainer.append(selectButtonContainer);

      root.append(selectContainer);

      tile.select = select;
      tile.prevButton = prevButton;
      tile.nextButton = nextButton;

      tile.updateHudScale();

    }

    html.find(".col.middle").append(root);

  }

  updateHudScale() {
    if (!this.select) return;
    const scale = get(hudScale) + 0.25;
    const fontSize = scale >= 1.0 ? 1.0 : Math.min(1.0, Math.max(0.25, lib.transformNumber(scale)))
    this.select.children().css("font-size", `${fontSize}rem`)
  }

  updateSelect() {
    if (!this.select?.length) return;
    this.select.empty();
    for (const [index, state] of this.flags.states.entries()) {
      this.select.append(`<option ${index === this.flags.currentStateIndex ? "selected" : ""} value="${index}">${state.name}</option>`)
    }
  }

  static onPreUpdate(tileDoc, changes) {
    let statefulTile = StatefulTile.get(tileDoc.uuid);
    if (hasProperty(changes, "texture.src") && statefulTile) {
      statefulTile.newCurrentTime = statefulTile.video.currentTime * 1000;
    }
  }

  static onUpdate(tileDoc, changes, firstUpdate = false) {
    let statefulTile = StatefulTile.get(tileDoc.uuid);
    if (hasProperty(changes, "texture.src") && statefulTile) {
      setTimeout(() => {
        statefulTile.texture = tileDoc.object.texture;
        statefulTile.video = tileDoc.object.texture.baseTexture.resource.source;
        statefulTile.still = false;
        statefulTile.playing = false;
        clearTimeout(statefulTile.timeout);
        game.video.play(statefulTile.video);
      }, 100);
    }
    if (!hasProperty(changes, CONSTANTS.FLAGS)) return;
    if (!statefulTile) {
      if (!tileDoc.object.isVideo || !getProperty(tileDoc, CONSTANTS.STATES_FLAG)?.length) return;
      statefulTile = StatefulTile.make(tileDoc, tileDoc.object.texture);
    }
    statefulTile.flags.updateData();
    Hooks.call("ats.updateState", tileDoc, statefulTile.flags.data, changes);
    if (!statefulTile.flags.states.length) {
      this.tearDown(tileDoc.uuid);
      tileHudMap.get(tileDoc.uuid)?.render(true);
      return;
    }
    statefulTile.offset = Number(new Date()) - statefulTile.flags.updated;
    if (hasProperty(changes, CONSTANTS.STATES_FLAG)) {
      tileHudMap.get(tileDoc.uuid)?.render(true);
      statefulTile.still = false;
      statefulTile.playing = false;
      clearTimeout(statefulTile.timeout);
      game.video.play(statefulTile.video);
      statefulTile.flags.data.queuedState = statefulTile.flags.determineNextStateIndex();
      return tileDoc.update({
        [CONSTANTS.QUEUED_STATE_FLAG]: statefulTile.flags.data.queuedState
      });
    }
    statefulTile.updateSelect();
    if (hasProperty(changes, CONSTANTS.CURRENT_STATE_FLAG) || firstUpdate) {
      if (statefulTile.nextButton) {
        statefulTile.nextButton.removeClass("active");
      }
      if (statefulTile.prevButton) {
        statefulTile.prevButton.removeClass("active");
      }
      statefulTile.still = false;
      statefulTile.playing = false;
      game.video.play(statefulTile.video);
    }
  }

  static async changeTileState(uuid, { state = null, step = 1, queue = false } = {}) {
    const tile = fromUuidSync(uuid);
    if (!tile) return false;
    const flags = new Flags(tile);
    flags.updateData();
    if (!flags.states.length) {
      return false;
    }
    if (state !== null && !queue) {
      if (!isRealNumber(state)) {
        return false;
      }
      return tile.update({
        [CONSTANTS.UPDATED_FLAG]: Number(Date.now()),
        [CONSTANTS.PREVIOUS_STATE_FLAG]: flags.currentStateIndex,
        [CONSTANTS.CURRENT_STATE_FLAG]: state,
        [CONSTANTS.QUEUED_STATE_FLAG]: flags.determineNextStateIndex()
      });
    }
    if (!isRealNumber(step)) {
      return false;
    }
    if (queue && !isRealNumber(state)) {
      return false;
    }
    return tile.update({
      [CONSTANTS.UPDATED_FLAG]: Number(Date.now()),
      [CONSTANTS.QUEUED_STATE_FLAG]: queue ? state : flags.getStateIndexFromSteps(step)
    });
  }

  async update(data) {
    if (game.user !== currentDelegator) return;

    data[CONSTANTS.UPDATED_FLAG] = Number(Date.now());

    if (game.user.isGM) {
      return this.document.update(data);
    } else if (lib.getResponsibleGM()) {
      return SocketHandler.emit(SocketHandler.UPDATE_TILE, {
        uuid: this.uuid,
        update: data,
        userId: lib.getResponsibleGM().id
      });
    }

    const deconstructedData = Object.fromEntries(Object.entries(data)
      .map(([key, value]) => {
        const newKey = key.split(".");
        return [newKey[newKey.length - 1], value];
      }));

    return game.user.update({
      [`${CONSTANTS.DELEGATED_TILES_FLAG}.${this.document.parent.id}_${this.document.id}`]: deconstructedData
    });
  }

  async queueState(newState) {
    const updates = {
      [CONSTANTS.QUEUED_STATE_FLAG]: newState
    };
    if (Hooks.call("ats.preUpdateQueuedState", this.document, this.flags.data, updates) === false) {
      return;
    }
    return this.update(updates);
  }

  async updateState(stateIndex) {
    const updates = {
      [CONSTANTS.PREVIOUS_STATE_FLAG]: this.flags.currentStateIndex,
      [CONSTANTS.CURRENT_STATE_FLAG]: stateIndex,
      [CONSTANTS.QUEUED_STATE_FLAG]: this.flags.determineNextStateIndex(stateIndex)
    };
    if (Hooks.call("ats.preUpdateCurrentState", this.document, this.flags.data, updates) === false) {
      return;
    }
    return this.update(updates);
  }

  async changeState({ state = null, step = 1, fast = false } = {}) {

    if (this.nextButton) {
      this.nextButton.removeClass("active");
    }
    if (this.prevButton) {
      this.prevButton.removeClass("active");
    }

    if (!fast && this.flags.currentState.behavior !== CONSTANTS.BEHAVIORS.STILL) {
      if (this.nextButton && this.prevButton && state === null) {
        this[step > 0 ? "nextButton" : "prevButton"].addClass("active");
      }
      return this.queueState(state ?? this.flags.currentStateIndex + step);
    }

    clearTimeout(this.timeout);
    this.timeout = false;

    return this.updateState(state ?? this.flags.currentStateIndex + step);

  }

  determineStartTime(stateIndex) {

    const currState = this.flags.states?.[stateIndex];
    const currStart = lib.isRealNumber(currState?.start)
      ? Number(currState?.start) * this.flags.fps
      : (currState?.start ?? 0);

    switch (currStart) {

      case CONSTANTS.START.START:
        return 0;

      case CONSTANTS.START.END:
        return this.duration;

      case CONSTANTS.START.MID:
        return Math.floor(this.duration / 2);

      case CONSTANTS.START.PREV:
        return this.determineEndTime(stateIndex - 1);

    }

    return currStart;
  }

  determineEndTime(stateIndex) {

    const currState = this.flags.states?.[stateIndex];
    const currEnd = lib.isRealNumber(currState?.end)
      ? Number(currState?.end) * this.flags.fps
      : (currState?.end ?? this.duration);

    switch (currEnd) {

      case CONSTANTS.END.END:
        return this.duration;

      case CONSTANTS.END.MID:
        return Math.floor(this.duration / 2);

      case CONSTANTS.END.NEXT:
        return this.determineStartTime(stateIndex + 1);

    }

    return currEnd;

  }

  evaluateVisibility() {
    const hidden = this.flags.currentState.behavior === CONSTANTS.BEHAVIORS.STILL_HIDDEN;
    this.document.object.renderable = !hidden || game.user.isGM;
    this.document.object.mesh.alpha = hidden ? (game.user.isGM ? 0.5 : 0.0) : this.document.alpha;
    return hidden;
  }

  async getVideoPlaybackState() {

    if (!this.ready) return {
      playing: false,
      loop: false,
      currentTime: 0
    };

    if (!this.flags?.states?.length || !this.document?.object) return;

    const startTime = this.newCurrentTime ?? this.determineStartTime(this.flags.currentStateIndex) ?? 0;
    const endTime = this.determineEndTime(this.flags.currentStateIndex) ?? this.duration;
    this.newCurrentTime = null;

    this.evaluateVisibility();

    this.still = false;
    this.playing = true;
    this.texture.update();

    switch (this.flags.currentState.behavior) {

      case CONSTANTS.BEHAVIORS.STILL:
      case CONSTANTS.BEHAVIORS.STILL_HIDDEN:
        return this.handleStillBehavior(startTime);

      case CONSTANTS.BEHAVIORS.LOOP:
        return this.handleLoopBehavior(startTime, endTime);

      default:
        return this.handleOnceBehavior(startTime, endTime);

    }
  }

  setTimeout(callback, waitDuration) {
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => {
      this.timeout = false;
      callback();
    }, waitDuration);
  }

  async handleStillBehavior(startTime) {

    this.still = true;

    const fn = () => {
      this.video.removeEventListener("seeked", fn);
      this.texture.update();
    }
    this.video.addEventListener("seeked", fn);

    this.video.play();
    this.video.currentTime = startTime / 1000;
    this.video.pause();

    return false;

  }

  async handleLoopBehavior(startTime, endTime = 0) {

    const loopDuration = (endTime - startTime);
    const offsetLoopTime = this.offset % loopDuration;
    const offsetStartTime = (startTime + offsetLoopTime);

    this.offset = 0;

    this.setTimeout(() => {
      this.playing = false;
      if (this.flags.queuedStateIndexIsDifferent) {
        return this.updateState(this.flags.queuedStateIndex);
      }
      game.video.play(this.video);
    }, loopDuration - offsetLoopTime);

    return {
      playing: true,
      loop: false,
      offset: offsetStartTime / 1000
    }

  }

  async handleOnceBehavior(startTime, endTime) {

    this.setTimeout(async () => {
      let queuedState = this.flags.queuedStateIndex;
      if (queuedState === null) {
        queuedState = this.flags.determineNextStateIndex();
      }
      this.playing = false;
      this.video.pause();
      return this.updateState(queuedState);
    }, (endTime - startTime));

    this.offset = 0;

    return {
      playing: true,
      loop: false,
      offset: startTime / 1000
    }

  }

}

class Flags {

  constructor(doc) {
    this.doc = doc;
    this.uuid = doc.uuid;
    this.delegationUuid = this.uuid.split(".")[1] + "_" + this.uuid.split(".")[3];
    this._data = false;
  }

  get data() {
    if (!this._data) {
      this._data = this.getData();
    }
    return this._data;
  }

  get states() {
    return this.data?.states ?? [];
  }

  get offset() {
    return this.data?.offset ?? 0;
  }

  get updated() {
    return this.data?.updated ?? 0;
  }

  get previousState() {
    return this.states[this.previousStateIndex];
  }

  get previousStateIndex() {
    return Math.max(0, Math.min(this.data.previousState ?? this.currentStateIndex, this.data.states.length - 1));
  }

  get currentState() {
    return this.states[this.currentStateIndex];
  }

  get currentStateIndex() {
    const defaultStateIndex = this.data.states.findIndex(state => state.default) ?? 0;
    return Math.max(0, Math.min(this.data.currentState ?? defaultStateIndex, this.data.states.length - 1));
  }

  get queuedState() {
    return this.states[this.queuedStateIndex];
  }

  get queuedStateIndex() {
    return this.data.queuedState > -1 ? this.data.queuedState : null;
  }

  get fps() {
    return this.data?.frames ? 1000 / (this.data?.fps || 25) : 1;
  }

  get queuedStateIndexIsDifferent() {
    return this.queuedStateIndex !== null && this.queuedStateIndex !== this.currentStateIndex;
  }

  getData() {
    const documentFlags = getProperty(this.doc, CONSTANTS.FLAGS);
    if (currentDelegator && !currentDelegator.isGM) {
      const userFlags = getProperty(currentDelegator, CONSTANTS.DELEGATED_TILES_FLAG + "." + this.delegationUuid);
      if (userFlags?.updated && documentFlags?.updated && userFlags?.updated > documentFlags?.updated) {
        return userFlags;
      }
    }
    return documentFlags;
  }

  copyData() {
    copiedData.set({
      [CONSTANTS.STATES_FLAG]: this.data.states,
      [CONSTANTS.FRAMES_FLAG]: this.data.frames,
      [CONSTANTS.FPS_FLAG]: this.data.fps,
      [CONSTANTS.CURRENT_STATE_FLAG]: this.currentStateIndex
    });
  }

  pasteData() {
    if (!copiedData) return;
    this.doc.update({
      ...foundry.utils.deepClone(get(copiedData))
    });
  }

  updateData() {
    this._data = this.getData();
  }

  getStateById(id) {
    const index = this.states.findIndex(state => state.id === id);
    return index >= 0 ? index : false;
  }

  getStateIndexFromSteps(steps = 1) {
    return Math.max(0, Math.min(this.currentStateIndex + steps, this.data.states.length - 1));
  }

  determineNextStateIndex(stateIndex = null) {

    stateIndex ??= this.currentStateIndex;

    const state = this.states[stateIndex];

    const index = Math.max(0, Math.min(stateIndex, this.states.length - 1));

    const defaultIndex = this.states.findIndex(s => s.default);

    switch (state?.behavior) {

      case CONSTANTS.BEHAVIORS.ONCE_NEXT:
        return this.states[index + 1] ? index + 1 : defaultIndex;

      case CONSTANTS.BEHAVIORS.ONCE_PREVIOUS:
        return this.states[index - 1] ? index - 1 : defaultIndex;

      case CONSTANTS.BEHAVIORS.ONCE_PREVIOUS_ACTIVE:
        return this.previousStateIndex;

      case CONSTANTS.BEHAVIORS.ONCE_SPECIFIC:
        const nextIndex = this.getStateById(state.nextState);
        return nextIndex >= 0 ? nextIndex : defaultIndex;
    }

    return index;

  }

}
