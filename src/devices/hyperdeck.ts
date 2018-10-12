import * as _ from 'underscore'
import * as underScoreDeepExtend from 'underscore-deep-extend'
import { DeviceWithState, DeviceOptions, CommandWithContext } from './device'
import { DeviceType, MappingHyperdeck, MappingHyperdeckType } from './mapping'

import { TimelineState } from 'superfly-timeline'
import { Hyperdeck, Commands as HyperdeckCommands, TransportStatus } from 'hyperdeck-connection'
import { DoOnTime } from '../doOnTime'
import { Conductor } from '../conductor'

_.mixin({ deepExtend: underScoreDeepExtend(_) })

function deepExtend<T> (destination: T, ...sources: any[]) {
	// @ts-ignore (mixin)
	return _.deepExtend(destination, ...sources)
}
/**
 * This is a wrapper for the Hyperdeck Device. Commands to any and all hyperdeck devices will be sent through here.
 */
export interface HyperdeckDeviceOptions extends DeviceOptions {
	options?: {
		commandReceiver?: (time: number, cmd) => Promise<any>
	}
}
export interface HyperdeckOptions {
	host: string
	port?: number
}
export enum TimelineContentTypeHyperdeck {
	TRANSPORT = 'transport'
}
export interface HyperdeckCommandWithContext {
	command: HyperdeckCommands.AbstractCommand
	context: CommandContext
}

export interface TransportInfoCommandResponseExt /*extends HyperdeckCommands.TransportInfoCommandResponse */ {
	Status: TransportStatus
	RecordFilename?: string
}

export interface DeviceState {
	notify: HyperdeckCommands.NotifyCommandResponse
	// slots: HyperdeckCommands.SlotInfoCommandResponse[]
	transport: TransportInfoCommandResponseExt
}

type CommandContext = any
export class HyperdeckDevice extends DeviceWithState<DeviceState> {

	private _doOnTime: DoOnTime

	private _hyperdeck: Hyperdeck
	private _initialized: boolean = false
	private _connected: boolean = false // note: ideally this should be replaced by this._hyperdeck.connected
	private _conductor: Conductor

	private _commandReceiver: (time: number, command: HyperdeckCommands.AbstractCommand, context: CommandContext) => Promise<any>

	constructor (deviceId: string, deviceOptions: HyperdeckDeviceOptions, options, conductor: Conductor) {
		super(deviceId, deviceOptions, options)
		if (deviceOptions.options) {
			if (deviceOptions.options.commandReceiver) this._commandReceiver = deviceOptions.options.commandReceiver
			else this._commandReceiver = this._defaultCommandReceiver
		}
		this._doOnTime = new DoOnTime(() => {
			return this.getCurrentTime()
		})
		this._doOnTime.on('error', e => this.emit('error', e))
		this._conductor = conductor
	}

	/**
	 * Initiates the connection with the Hyperdeck through the hyperdeck-connection lib.
	 */
	init (options: HyperdeckOptions): Promise<boolean> {
		return new Promise((resolve/*, reject*/) => {
			let firstConnect = true

			this._hyperdeck = new Hyperdeck()
			this._hyperdeck.connect(options.host, options.port)
			this._hyperdeck.on('connected', () => {
				return this._queryCurrentState().then(state => {
					this.setState(state, this.getCurrentTime())
					this._connected = true
					if (firstConnect) { // TODO - or was the call order different before?
						firstConnect = false
						this._initialized = true
						resolve(true)
					}

					this.emit('connectionChanged', true)
					this._conductor.resetResolver()
				})
			})
			this._hyperdeck.on('disconnected', () => {
				this._connected = false
				this.emit('connectionChanged', false)
			})
			this._hyperdeck.on('error', (e) => this.emit('error', e))
		})
	}
	terminate (): Promise<boolean> {
		this._doOnTime.dispose()

		return new Promise((resolve) => {
			// TODO: implement dispose function in hyperdeck-connection
			// this._hyperdeck.dispose()
			// .then(() => {
			// resolve(true)
			// })
			resolve(true)
		})
	}

	makeReady (okToDestroyStuff?: boolean): Promise<void> {
		if (okToDestroyStuff) {
			this._doOnTime.clearQueueNowAndAfter(this.getCurrentTime())

			// TODO - could this being slow/offline be a problem?
			return this._queryCurrentState().then(state => {
				this.setState(state, this.getCurrentTime())
			})
		}
		return Promise.resolve()
	}

	handleState (newState: TimelineState) {
		if (!this._initialized) {
			// before it's initialized don't do anything
			this.emit('info', 'Hyperdeck not initialized yet')
			return
		}
		let oldState: DeviceState = (this.getStateBefore(newState.time) || { state: this._getDefaultState() }).state

		let oldHyperdeckState = oldState
		let newHyperdeckState = this.convertStateToHyperdeck(newState)

		this.emit('info', 'Hyperdeck STATE: ' + JSON.stringify(newHyperdeckState))

		let commandsToAchieveState: Array<HyperdeckCommandWithContext> = this._diffStates(oldHyperdeckState, newHyperdeckState)

		// clear any queued commands later than this time:
		this._doOnTime.clearQueueNowAndAfter(newState.time)
		// add the new commands to the queue:
		this._addToQueue(commandsToAchieveState, newState.time)

		// store the new state, for later use:
		this.setState(newHyperdeckState, newState.time)
	}
	clearFuture (clearAfterTime: number) {
		// Clear any scheduled commands after this time
		this._doOnTime.clearQueueAfter(clearAfterTime)
	}
	get canConnect (): boolean {
		return true
	}
	get connected (): boolean {
		return this._connected
	}
	convertStateToHyperdeck (state: TimelineState): DeviceState {
		if (!this._initialized) throw Error('convertStateToHyperdeck cannot be used before inititialized')

		// Convert the timeline state into something we can use easier:
		const deviceState = this._getDefaultState()

		const sortedLayers = _.map(state.LLayers, (tlObject, layerName) => ({ layerName, tlObject }))
			.sort((a,b) => a.layerName.localeCompare(b.layerName))

		_.each(sortedLayers, ({ tlObject, layerName }) => {
			const content = tlObject.resolved || tlObject.content
			const mapping = this.mapping[layerName] as MappingHyperdeck

			if (mapping) {
				switch (mapping.mappingType) {
					case MappingHyperdeckType.Transport:
						if (content.type === TimelineContentTypeHyperdeck.TRANSPORT) {
							if (deviceState.transport) {
								deepExtend(deviceState.transport, content.attributes)
							} else {
								deviceState.transport = content.attributes
							}
						}
						break
				}
			}
		})

		return deviceState
	}
	get deviceType () {
		return DeviceType.HYPERDECK
	}
	get deviceName (): string {
		return 'Hyperdeck ' + this.deviceId
	}
	get queue () {
		return this._doOnTime.getQueue()
	}
	private _addToQueue (commandsToAchieveState: Array<HyperdeckCommandWithContext>, time: number) {
		_.each(commandsToAchieveState, (cmd: HyperdeckCommandWithContext) => {

			// add the new commands to the queue:
			this._doOnTime.queue(time, (cmd: HyperdeckCommandWithContext) => {
				return this._commandReceiver(time, cmd.command, cmd.context)
			}, cmd)
		})
	}

	private _diffStates (oldAbstractState: DeviceState, newAbstractState: DeviceState): Array<HyperdeckCommandWithContext> {
		const commandsToAchieveState: HyperdeckCommandWithContext[] = []

		if (oldAbstractState.notify && newAbstractState.notify) {
			const notifyCmd = new HyperdeckCommands.NotifySetCommand()
			let hasChange = false

			if (oldAbstractState.notify.Remote !== newAbstractState.notify.Remote) {
				hasChange = true
				notifyCmd.Remote = newAbstractState.notify.Remote
			}
			if (oldAbstractState.notify.Transport !== newAbstractState.notify.Transport) {
				hasChange = true
				notifyCmd.Transport = newAbstractState.notify.Transport
			}
			if (oldAbstractState.notify.Slot !== newAbstractState.notify.Slot) {
				hasChange = true
				notifyCmd.Slot = newAbstractState.notify.Slot
			}
			if (oldAbstractState.notify.Configuration !== newAbstractState.notify.Configuration) {
				hasChange = true
				notifyCmd.Configuration = newAbstractState.notify.Configuration
			}
			if (oldAbstractState.notify.DroppedFrames !== newAbstractState.notify.DroppedFrames) {
				hasChange = true
				notifyCmd.DroppedFrames = newAbstractState.notify.DroppedFrames
			}

			if (hasChange) {
				commandsToAchieveState.push({
					command: notifyCmd,
					context: null // TODO
				})
			}
		}

		if (oldAbstractState.transport && newAbstractState.transport) {
			switch (newAbstractState.transport.Status) {
				case TransportStatus.Record:
					if (oldAbstractState.transport.Status === newAbstractState.transport.Status) {
						if (oldAbstractState.transport.RecordFilename === undefined || oldAbstractState.transport.RecordFilename === newAbstractState.transport.RecordFilename) {
							// TODO - sometimes we can loose track of the filename, should we split the record when recovering from that? (it might loose some frames)
							break
						}
						commandsToAchieveState.push({
							command: new HyperdeckCommands.StopCommand(),
							context: null // TODO
						})
					}

					commandsToAchieveState.push({
						command: new HyperdeckCommands.RecordCommand(newAbstractState.transport.RecordFilename),
						context: null // TODO
					})
					break
				default:
					// TODO - warn
					// for now we are assuming they want a stop. that could be conditional later on
					if (oldAbstractState.transport.Status === TransportStatus.Record) {
						commandsToAchieveState.push({
							command: new HyperdeckCommands.StopCommand(),
							context: null // TODO
						})
					}
					break
			}

		}

		return commandsToAchieveState
	}

	private async _queryCurrentState (): Promise<DeviceState> {
		if (!this._connected) return this._getDefaultState()

		const notify = new HyperdeckCommands.NotifyGetCommand()
		const transport = new HyperdeckCommands.TransportInfoCommand()
		this._hyperdeck.sendCommand(notify, transport)

		const notifyRes = await notify
		const transportRes = await transport

		const res: DeviceState = {
			notify: notifyRes,
			transport: transportRes
		}
		return res
	}

	private _getDefaultState (): DeviceState {
		const res: DeviceState = {
			notify: { // TODO - this notify block will want configuring per device or will the state lib always want it the same?
				Remote: false,
				Transport: false,
				Slot: false,
				Configuration: false,
				DroppedFrames: false
			},
			transport: {
				Status: TransportStatus.Preview
			}
		}

		return res
	}

	private _defaultCommandReceiver (time: number, command: HyperdeckCommands.AbstractCommand, context: CommandContext): Promise<any> {
		time = time // seriously this needs to stop
		let cwc: CommandWithContext = {
			context: context,
			command: command
		}
		this.emit('debug', cwc)

		this._hyperdeck.sendCommand(command)
		return command
	}
}
