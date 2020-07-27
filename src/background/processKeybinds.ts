import { Keybind, Command, StateView, StateViewSelector, AdjustMode } from "../types"
import { CommandName, commandInfos } from "../defaults/commands"
import { sendMessageToConfigSync, formatSpeed, intoFxFlags, sendMediaEvent, createFeedbackAudio } from "../utils/configUtils"
import { TabInfo, requestCreateTab } from "../utils/browserUtils"
import { MediaEvent } from "../contentScript/utils/applyMediaEvent"
import { OverlayShowOpts } from "../contentScript/Overlay"
import { round, clamp, isFirefox } from "../utils/helper"
import { FlatMediaInfo } from "../contentScript/utils/genMediaInfo"
import { getDefaultFx, getDefaultAudioFx } from "../defaults"
import { filterInfos } from "../defaults/filters"
import produce from "immer"

let feedbackAudio = isFirefox() ? null : createFeedbackAudio()
let feedbackBadAudio = isFirefox() ? null : createFeedbackAudio(false)

export async function processKeybinds(keybinds: Keybind[], tabInfo: TabInfo) {
  const fetch = (selector: StateViewSelector) => {
    return window.globalState.get(selector, tabInfo?.tabId)
  }

  const show = (opts: OverlayShowOpts) => {
    if (!tabInfo || fetch({hideIndicator: true}).hideIndicator) return 
    sendMessageToConfigSync({type: "SHOW_INDICATOR", opts, requiresFocus: tabInfo.frameId == null ? true : false}, tabInfo.tabId, tabInfo.frameId)
  }

  let media: FlatMediaInfo
  let mediaLoaded = false 

  let applyToMedia = (e: MediaEvent) => {
    if (!media) return 
    sendMediaEvent(e, media.key, media.tabInfo.tabId, media.tabInfo.frameId)
  };

  let feedback: HTMLAudioElement = feedbackAudio
  const setFeedback = (fb: HTMLAudioElement) => {
    feedback = fb 
  } 


  for (let kb of keybinds) {
    let commandInfo = commandInfos[kb.command]

    if (commandInfo.requiresMedia) {
      media = mediaLoaded ? media : window.globalMedia.getAuto(tabInfo)
      if (!media) {
        setFeedback(feedbackBadAudio)
        continue 
      }
    }

    let lazyValues: {value: number, nextIncrement: number}
    const getCycleValue = () => {
      if (lazyValues) return lazyValues.value
      const nextIncrement = (kb.cycleIncrement ?? 0) + 1
      if (!(kb.valueCycle?.length > 0)) {
        throw Error("No items in cycle")
      }
      lazyValues = {value: kb.valueCycle[nextIncrement % kb.valueCycle.length], nextIncrement}
      return lazyValues.value
    }

    const autoCapture = (value: number) => {
      if (tabInfo?.tabId == null) return 
      if (value?.toFixed(6) !== commandInfo.valueDefault.toFixed(6)) {
        window.captureMgr.captureTab(tabInfo.tabId).catch(err => {})
      } 
    }
    
    const override = {} as StateView
    try {
      commandHandlers[kb.command]({
        autoCapture,
        getCycleValue,
        setFeedback,
        fetch,
        override,
        kb,
        commandInfo,
        tabInfo,
        media,
        applyToMedia,
        show
      })

      if (lazyValues) {
        const allKeybinds = window.globalState.get({keybinds: true}).keybinds || [];
        override.keybinds = produce(override.keybinds ?? allKeybinds, d => {
          const dKb = d.find(dKb => dKb.id === kb.id)
          dKb.cycleIncrement = lazyValues.nextIncrement
        }) 
      }

      if (Object.keys(override).length) {
        window.globalState.set({override, tabId: tabInfo?.tabId}, "kb")
      }
    } catch (err) {
      setFeedback(feedbackBadAudio)
      break 
    }
  }

  window.globalState.unfreeze("kb")

  if (feedback) {
    feedback.volume = fetch({feedbackVolume: true}).feedbackVolume ?? 0.5
    feedback.currentTime = 0 
    feedback.volume && feedback.play()
  }
}

type CommandHandlerArgs = {
  autoCapture: (v: number) => void,
  getCycleValue: () => number,
  setFeedback: (fb: HTMLAudioElement) => void,
  fetch: (selector: StateViewSelector) => StateView,
  override: StateView,
  kb: Keybind, 
  commandInfo: Command,
  tabInfo: TabInfo,
  media: FlatMediaInfo,
  applyToMedia: (event: MediaEvent) => void 
  show: (opts: OverlayShowOpts) => void
}

const commandHandlers: {
  [key in CommandName]: (args: CommandHandlerArgs) => Promise<void>
} = {
  nothing: async args => {args.setFeedback(null)},
  runCode: async args => {
    const { kb, tabInfo } = args
    if (!tabInfo) {
      args.setFeedback(feedbackBadAudio)
      return 
    } 
    sendMessageToConfigSync({type: "INJECT_SCRIPT", requiresFocus: tabInfo.frameId == null ? true : false, code: kb.valueString}, tabInfo.tabId, tabInfo.frameId)
  },
  openUrl: async args => {
    const { kb } = args 
    if (chrome.tabs.create) {
      chrome.tabs.create({
        url: kb.valueString
      })
    } else if (chrome.runtime.sendMessage) {
      requestCreateTab(kb.valueString)
    } 
  },
  setState: async args => {
    const { kb, show, override, fetch } = args 
    const view = fetch({enabled: true})
    if (kb.valueState === "off" || (kb.valueState === "toggle" && view.enabled)) {
      override.enabled = false 
    } else {
      override.enabled = true
    }
    show({
      text: ` ${window.gsm.token[override.enabled ? "on" : "off"]}`,
      icons: ["power"]
    })
  },
  setPin: async args => {
    const { kb, tabInfo, override, show, fetch } = args 
    if (!tabInfo) {
      args.setFeedback(feedbackBadAudio)
      return 
    } 
    const view = fetch({speed: true, isPinned: true})
    let speed = view.speed
    if (kb.valueState === "off" || (kb.valueState === "toggle" && view.isPinned)) {
      override.isPinned = false 
      if (view.isPinned) {
        speed = window.globalState.state.common.speed
      }
    } else {
      override.isPinned = true 
    }
    show({text: formatSpeed(speed, override.isPinned)})
  },
  adjustSpeed: async args => {
    const { kb, show, fetch, override, commandInfo, getCycleValue } = args 
    const view = fetch({speed: true, isPinned: true, keybinds: true, lastSpeed: true})
    
    let value: number 

    if (kb.adjustMode === AdjustMode.CYCLE) {
      value = getCycleValue()
    } else if (kb.adjustMode === AdjustMode.SET) {
      value = kb.valueNumber ?? commandInfo.valueDefault
    } else if (kb.adjustMode === AdjustMode.ADD) {
      value = (view.speed ?? 1) + (kb.valueNumberAlt ?? commandInfo.valueStep)
    }

    if (value == null || isNaN(value)) {
      throw Error("Value not NULL or NaN.")
    }

    value = clamp(commandInfo.valueMin, commandInfo.valueMax, value)
    if (kb.adjustMode === AdjustMode.SET && (value === view.speed) && view.lastSpeed != null) {
      override.speed = view.lastSpeed
    } else {
      override.speed = value 
    } 
    override.lastSpeed = view.speed  
 
    show({text: formatSpeed(override.speed, view.isPinned)})
  },
  seek: async args => {
    const { kb, media, applyToMedia, show, fetch } = args
    const speed = fetch({speed: true}).speed ?? 1
    const value = kb.valueBool ? kb.valueNumber * speed : kb.valueNumber
    const text = ` ${round(value, 2)}`

    kb.valueNumber >= 0 ? show({icons: ["forward"], text}) : show({icons: ["backward"], text}) 
    applyToMedia({type: "SEEK", value, relative: true})
  },
  setPause: async args => {
    const { kb, media, applyToMedia, show } = args 
    if (kb.valueState === "off" || (kb.valueState === "toggle" && media.paused)) {
      show({icons: ["play"]})
    } else {
      show({icons: ["pause"]})
    }

    applyToMedia({type: "PAUSE", state: kb.valueState})
  },
  setMute: async args => {
    const { kb, media, applyToMedia, show } = args 

    if (kb.valueState === "off" || (kb.valueState === "toggle" && media.muted)) {
      show({text: `${Math.round(media.volume * 100)}%`})
    } else {
      show({text: "0%"})
    }

    applyToMedia({type: "MUTE", state: kb.valueState}) 
  },
  adjustVolume: async args => {
    const { kb, media, applyToMedia, show, commandInfo } = args 
    const delta = kb.valueNumber ?? commandInfo.valueDefault
    show({text: `${(clamp(0, 1, media.volume + delta) * 100).toFixed(Math.abs(delta) >= 0.01 ? 0 : 1)}%`})
    applyToMedia({type: "SET_VOLUME", value: delta, relative: true})
  },
  setMark: async args => {
    const { kb, applyToMedia, show } = args 
    show({
      icons: ["bookmark"],
      text: ` ${kb.valueString}`,
      small: true
    })
    applyToMedia({type: "SET_MARK", key: kb.valueString})
  },
  seekMark: async args => {
    const { media, kb, applyToMedia, show } = args 
    show({
      icons:  media.marks.includes(kb.valueString) ? ["arrowRight", "bookmark"] : ["arrowRight", "bookmark"],
      text: ` ${kb.valueString}`,
      small: true
    })
    applyToMedia({type: "SEEK_MARK", key: kb.valueString})
  },
  toggleLoop: async args => {
    const { media, kb, applyToMedia, show } = args 
    if (media.marks.includes(kb.valueString)) {
      show({
        icons: ["loop"],
        text: ` ${media.inLoop ? "off" : "on"}`,
        small: true,
      })
      applyToMedia({type: "TOGGLE_LOOP", key: kb.valueString})
      return 
    } 

    args.setFeedback(feedbackBadAudio)
    show({
      icons: ["loop"],
      text: ` ${kb.valueString}???`,
      small: true,
    })
  },
  setFx: async args => {
    const { kb, fetch, override, show } = args
    let view = fetch({elementFx: true, backdropFx: true})
    const flags = intoFxFlags(kb.filterTarget)
    if (flags.element) {
      const enabled = kb.valueState === "on" || (kb.valueState === "toggle" && !view.elementFx.enabled)
      override.elementFx = {...view.elementFx, enabled}
    } 
    if (flags.backdrop) {
      const enabled = kb.valueState === "on" || (kb.valueState === "toggle" && !view.backdropFx.enabled)
      override.backdropFx = {...view.backdropFx, enabled} 
    }

    show({
      icons: ["fx", "power"]
    })
  },
  resetFx: async args => {
    const { kb, show, override } = args 
    const flags = intoFxFlags(kb.filterTarget)
    if (flags.element) {
      override.elementFx = getDefaultFx()
    } 
    if (flags.backdrop) {
      override.backdropFx = getDefaultFx()
    }
    show({icons: ["fx", "reset"]})
  },
  flipFx: async args => {
    const { fetch, show, override } = args 
    const view = fetch({backdropFx: true, elementFx: true})
    override.elementFx = view.backdropFx
    override.backdropFx = view.elementFx
    show({icons: ["swap"]})
  },
  adjustFilter: async args => {
    const { kb, show, fetch, override, getCycleValue } = args 
    const { element, backdrop } = intoFxFlags(kb.filterTarget)
    const filterInfo = filterInfos[kb.filterOption]
    if (!filterInfo) throw Error("No filter type provided.")

    let lazyValue: {relative: boolean, value: number};
    if (kb.adjustMode === AdjustMode.CYCLE) {
      lazyValue = {relative: false, value: getCycleValue() ?? filterInfo.default}
    } else if (kb.adjustMode === AdjustMode.SET) {
      lazyValue = {relative: false, value: kb.valueNumber ?? filterInfo.default}
    } else if (kb.adjustMode === AdjustMode.ADD) {
      lazyValue = {relative: true, value: kb.valueNumberAlt ?? filterInfo.step}
    }

    const newValues: Set<number> = new Set()

    Object.assign(override, (
      produce(fetch({elementFx: true, backdropFx: true}), view => {
        if (element) {
          view.elementFx.enabled = true
          const filter = view.elementFx[filterInfo.isTransform ? "transforms" : "filters"].find(filter => filter.name === kb.filterOption)
          filter.value = clamp(filterInfo.min, filterInfo.max, lazyValue.relative ? filter.value + lazyValue.value : lazyValue.value)
          newValues.add(filter.value)
        }

        if (backdrop) {
          view.backdropFx.enabled = true
          const filter = view.backdropFx[filterInfo.isTransform ? "transforms" : "filters"].find(filter => filter.name === kb.filterOption)
          filter.value = clamp(filterInfo.min, filterInfo.max, lazyValue.relative ? filter.value + lazyValue.value : lazyValue.value)
          newValues.add(filter.value)
        }
      })
    ))

    show({
      text: Array.from(newValues).map(v => v.toFixed(2)).join("\n")
    })
  },
  adjustPitch: async args => {
    const { kb, fetch, show, override, getCycleValue, commandInfo, tabInfo } = args 
    let { audioFx } = fetch({audioFx: true})
    audioFx = audioFx || getDefaultAudioFx()

    let value: number
    if (kb.adjustMode === AdjustMode.CYCLE) {
      value = getCycleValue()
    } else if (kb.adjustMode === AdjustMode.SET) {
      value = kb.valueNumber ?? commandInfo.valueDefault
    } else if (kb.adjustMode === AdjustMode.ADD) {
      value = audioFx.pitch + (kb.valueNumberAlt ?? commandInfo.valueStep)
    }

    if (value == null || isNaN(value)) throw Error("Value not NULL or NaN.")

    override.audioFx = {...audioFx, pitch: clamp(commandInfo.valueMin, commandInfo.valueMax, value)}

    args.autoCapture(override.audioFx.pitch)

    show({text: `${(override.audioFx.pitch * 100).toFixed(0)}%`})
  },
  adjustGain: async args => {
    const { kb, fetch, show, override, getCycleValue, commandInfo, tabInfo } = args 
    let { audioFx } = fetch({audioFx: true})
    audioFx = audioFx || getDefaultAudioFx()

    let value: number
    if (kb.adjustMode === AdjustMode.CYCLE) {
      value = getCycleValue()
    } else if (kb.adjustMode === AdjustMode.SET) {
      value = kb.valueNumber ?? commandInfo.valueDefault
    } else if (kb.adjustMode === AdjustMode.ADD) {
      value = audioFx.volume + (kb.valueNumberAlt ?? commandInfo.valueStep)
    }

    if (value == null || isNaN(value)) throw Error("Value not NULL or NaN.")

    override.audioFx = {...audioFx, volume: clamp(commandInfo.valueMin, commandInfo.valueMax, value)}

    args.autoCapture(override.audioFx.volume)

    show({text: `${(override.audioFx.volume * 100).toFixed(0)}%`})
  },
  adjustDelay: async args => {
    const { kb, fetch, show, override, getCycleValue, commandInfo, tabInfo } = args 
    let { audioFx } = fetch({audioFx: true})
    audioFx = audioFx || getDefaultAudioFx()

    let value: number
    if (kb.adjustMode === AdjustMode.CYCLE) {
      value = getCycleValue()
    } else if (kb.adjustMode === AdjustMode.SET) {
      value = kb.valueNumber ?? commandInfo.valueDefault
    } else if (kb.adjustMode === AdjustMode.ADD) {
      value = audioFx.delay + (kb.valueNumberAlt ?? commandInfo.valueStep)
    }

    if (value == null || isNaN(value)) throw Error("Value not NULL or NaN.")

    override.audioFx = {...audioFx, delay: clamp(commandInfo.valueMin, commandInfo.valueMax, value)}

    args.autoCapture(override.audioFx.delay)

    show({text: `${override.audioFx.delay.toFixed(2)}`})
  },
  tabCapture: async args => {
    const { kb, show, setFeedback, tabInfo } = args 
    if (!tabInfo) {
      setFeedback(feedbackBadAudio)
      return 
    }

    let state = "off"


    try {
      if (kb.valueState === "off") {
        window.captureMgr.releaseTab(tabInfo.tabId)
      } else if (kb.valueState === "on") {
        await window.captureMgr.captureTab(tabInfo.tabId)
        state = "on"
      } else {
        await window.captureMgr.handleToggleTab(tabInfo.tabId)
        if (window.captureMgr.infos.find(info => info.tabId === tabInfo.tabId)) {
          state = "on"
        }
      }
    } catch (err ) {
      setFeedback(feedbackBadAudio)
      return 
    }

    show({text: state})
  },
}


