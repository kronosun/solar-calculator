import React, { Component } from 'react';
import mapboxgl from 'mapbox-gl';
import MapboxGeocoder from '@mapbox/mapbox-gl-geocoder';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import * as turf from '@turf/turf';
import PvWattsApi from '../api/PvWattsApi';
import * as PvWatts from '../api/PvWatts';
import MapMenu, { SolarCalculationState } from './MapMenu';

class SolarMap extends Component<ISolarMapProps, ISolarMapState> {
	private readonly SOLAR_CALCULATION_WAIT = 500; // 0.5 seconds

	private pvWattsApi: PvWattsApi;

	private moduleEfficiency = 0.15;
	private solarCalculationTimeout: number = -1;

	constructor(props: ISolarMapProps) {
		super(props);

		this.pvWattsApi = new PvWattsApi();
		
		this.state = {
			solarCalculationState: SolarCalculationState.blank,
		};
	}

	public render() {
		return (
			<div className="solarmap">
				<div id="mapbox-container" className="mapbox-container"></div>
				<MapMenu solarCalculationState={this.state.solarCalculationState}/>
				<style jsx>
					{`
					.solarmap {
						position: relative;
						width: 100%;
						height: 100vh;
					}

					.mapbox-container {
						position: absolute;
						top: 0;
						bottom: 0;
						left: 0;
						right: 0;
					}
				`}
				</style>
				<style jsx global>
					{`
					.mapboxgl-ctrl-top-right {
						display: flex;						
					}
				`}
				</style>
			</div>
		);
	}

	public componentDidMount() {
		mapboxgl.accessToken = 'pk.eyJ1IjoibHJ2b2xsZSIsImEiOiJjajFpcndxN2swMWJ0MnFvaG1uaWNlOHVkIn0.ptRQFGDH9slee6PowWtXOg';

		const map = new mapboxgl.Map({
			container: 'mapbox-container',
			style: 'mapbox://styles/lrvolle/ck6l3i57b1bhs1imlp62ugefg',
			center: [-98.5795, 39.8283],
			zoom: 3,
		});

		map.addControl(new mapboxgl.GeolocateControl({
			positionOptions: {
				enableHighAccuracy: true
			},
			trackUserLocation: true
		}));

		map.addControl(
			new MapboxGeocoder({
				accessToken: mapboxgl.accessToken,
				mapboxgl: mapboxgl
			})
		);

		const draw = new MapboxDraw({
			displayControlsDefault: false,
			controls: {
				polygon: true,
				trash: true
			},
			// modes: MapboxDraw.modes.DIRECT_SELECT,
			styles: [
				// ACTIVE (being drawn)
				// line stroke
				{
					"id": "gl-draw-line",
					"type": "line",
					"filter": ["all", ["==", "$type", "LineString"], ["!=", "mode", "static"]],
					"layout": {
					  "line-cap": "round",
					  "line-join": "round"
					},
					"paint": {
					  "line-color": "#001484",
					  "line-dasharray": [0.2, 2],
					  "line-width": 2
					}
				},
				// polygon fill
				{
				  "id": "gl-draw-polygon-fill",
				  "type": "fill",
				  "filter": ["all", ["==", "$type", "Polygon"], ["!=", "mode", "static"]],
				  "paint": {
					"fill-color": "#fbdc75",
					"fill-outline-color": "#001484",
					"fill-opacity": 0.5
					// "background-pattern": ""
				  }
				},
				// polygon outline stroke
				// This doesn't style the first edge of the polygon, which uses the line stroke styling instead
				{
				  "id": "gl-draw-polygon-stroke-active",
				  "type": "line",
				  "filter": ["all", ["==", "$type", "Polygon"], ["!=", "mode", "static"]],
				  "layout": {
					"line-cap": "round",
					"line-join": "round"
				  },
				  "paint": {
					"line-color": "#001484",
					"line-dasharray": [0.2, 2],
					"line-width": 2
				  }
				},
				// vertex point halos
				{
				  "id": "gl-draw-polygon-and-line-vertex-halo-active",
				  "type": "circle",
				  "filter": ["all", ["==", "meta", "vertex"], ["==", "$type", "Point"], ["!=", "mode", "static"]],
				  "paint": {
					"circle-radius": 5,
					"circle-color": "#FFF"
				  }
				},
				// vertex points
				{
				  "id": "gl-draw-polygon-and-line-vertex-active",
				  "type": "circle",
				  "filter": ["all", ["==", "meta", "vertex"], ["==", "$type", "Point"], ["!=", "mode", "static"]],
				  "paint": {
					"circle-radius": 3,
					"circle-color": "#001484",
				  }
				},
			
				// INACTIVE (static, already drawn)
				// line stroke
				{
					"id": "gl-draw-line-static",
					"type": "line",
					"filter": ["all", ["==", "$type", "LineString"], ["==", "mode", "static"]],
					"layout": {
					  "line-cap": "round",
					  "line-join": "round"
					},
					"paint": {
					  "line-color": "#000",
					  "line-width": 3
					}
				},
				// polygon fill
				{
				  "id": "gl-draw-polygon-fill-static",
				  "type": "fill",
				  "filter": ["all", ["==", "$type", "Polygon"], ["==", "mode", "static"]],
				  "paint": {
					"fill-color": "#000",
					"fill-outline-color": "#000",
					"fill-opacity": 0.1
				  }
				},
				// polygon outline
				{
				  "id": "gl-draw-polygon-stroke-static",
				  "type": "line",
				  "filter": ["all", ["==", "$type", "Polygon"], ["==", "mode", "static"]],
				  "layout": {
					"line-cap": "round",
					"line-join": "round"
				  },
				  "paint": {
					"line-color": "#000",
					"line-width": 3
				  }
				}
			  ],
		});
		map.addControl(draw);

		map.on('draw.create', (evt) => this.UpdateArea(evt, draw));
		map.on('draw.delete', (evt) => this.UpdateArea(evt, draw));
		map.on('draw.update', (evt) => this.UpdateArea(evt, draw));
	}

	private UpdateArea(evt: Event, draw: MapboxDraw) {
		const polygonData = draw.getAll();

		if (polygonData.features.length > 0) {
			// Loading indicator to show data isn't up to date
			this.SetSolarCalculationState(SolarCalculationState.loading);

			// Reset timeout. We only make a query every SOLAR_CALCULATION_WAIT so that requests aren't being made
			// while the user is currently updating the polygon, and so that we don't overload the API.
			if (this.solarCalculationTimeout >= 0)
				clearTimeout(this.solarCalculationTimeout);

			this.solarCalculationTimeout = window.setTimeout(() => {
				// Make request for solar calculation and handle result
				const solarCalculation = this.UpdateSolarCalculation(polygonData);
				this.HandleSolarCalculation(solarCalculation);
			}, this.SOLAR_CALCULATION_WAIT);

		} else { // Polygon deleted
			this.SetSolarCalculationState(SolarCalculationState.blank);

			if (evt.type !== 'draw.delete')
				alert('Use the draw tools to draw a polygon!');
		}
	}

	private HandleSolarCalculation(solarCalculation: Promise<PvWatts.Response>) {
		solarCalculation.then((response) => {
			if (response.errors)
				this.SetSolarCalculationState(SolarCalculationState.error, undefined, response.errors.join('\r\n"'));

			this.SetSolarCalculationState(SolarCalculationState.value, response.outputs);
		});
		
		solarCalculation.catch((reason) => {
			console.error(reason);
			this.SetSolarCalculationState(SolarCalculationState.error, undefined, reason instanceof Error ? reason.message : undefined);
		});
	}

	private SetSolarCalculationState(state: SolarCalculationState, values?: PvWatts.ResponseOutput, errorMessage?: string) {
		// Remove any style modifications


		// Set loading/error styles
		if (state === SolarCalculationState.loading) {

		} else if (state === SolarCalculationState.error) {
			// if (errorMessage)
			
		} else if (state === SolarCalculationState.value) {
			// Set solar calulation values

		}
	}

	/**
	 * Requests the PvWatts API to calculate the solar array output.
	 * @param polygonData Mapbox GeoJSON data for calculating 
	 */
	private async UpdateSolarCalculation(polygonData: any) {
		// Use turf to calculate necessary/relevant info about the polygon
		const area = turf.area(polygonData); // square meters
		const system_capacity = area * this.moduleEfficiency; // DC System Size in kW
		if (system_capacity > 500000)
			throw "System capacity exceeds the maximum, please reduce the area or decrease module efficiency.";

		if (system_capacity < 0.05)
			throw "System capacity does not meet minimum, please increase the area or module efficiency.";

		const centroid = turf.centroid(polygonData);
		if (!centroid.geometry)
			throw "Could not calculate centroid of polygon.";

		const [lon, lat] = centroid.geometry.coordinates;

		return this.pvWattsApi.GetPvWattsData({ system_capacity, lat, lon });
	}
}

interface ISolarMapProps {
}

interface ISolarMapState {
	solarCalculationState: SolarCalculationState;
}

export default SolarMap;
