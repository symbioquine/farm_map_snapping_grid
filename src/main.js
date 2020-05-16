import Draw from 'ol/interaction/Draw';
import VectorSource from 'ol/source/Vector';
import Feature from 'ol/Feature';
import Snap from 'ol/interaction/Snap';
import { getCenter as getExtentCenter } from 'ol/extent';
import { MultiPoint, Point } from 'ol/geom';
import { Vector as VectorLayer } from 'ol/layer';
import { getDistance as getSphericalDistance } from 'ol/sphere';
import {
  Circle as CircleStyle,
  Fill,
  Stroke,
  Style,
} from 'ol/style';
import { getVectorContext } from 'ol/render';
import Collection from 'ol/Collection';

import Control from 'ol/control/Control';
import { CLASS_CONTROL, CLASS_UNSELECTABLE } from 'ol/css';
import EventType from 'ol/events/EventType';

import forEachLayer from './utils/forEachLayer';

import './SnappingGrid.css';

// Snapping Grid behavior.
(function () {

  const MAX_POINTS_PER_SIDE = 64;

  window.farmOS.map.behaviors.farm_map_snapping_grid = {
    attach(instance) {
      const { map, units } = instance;

      // Attach only if/after edit controls are attached
      map.getControls().on('add', () => {
        // Don't enable if edit controls aren't enabled
        if (!instance.edit) {
          return;
        }

        // Don't enable multiple times
        if (instance.snappingGrid) {
          return;
        }

        const snappingGridFeature = new Feature();

        instance.snappingGrid = new SnappingGridControls({ map, units, snappingGridFeature });
        map.addControl(instance.snappingGrid);

        // When Snap interactions are added, register our grid feature
        map.getInteractions().on('add', (event) => {
          const interaction = event.element;

          if (interaction !== instance.edit.snapInteraction) {
            return;
          }

          interaction.addFeature(snappingGridFeature);
        });

        // When Snap interactions are removed, unregister our grid feature
        map.getInteractions().on('remove', (event) => {
          const interaction = event.element;

          if (interaction !== instance.edit.snapInteraction) {
            return;
          }

          interaction.removeFeature(snappingGridFeature);
        });

      });

    },
  };

  /**
   * @returns a vector source which always returns all its features - ignoring extents.
   * @private
   */
  function createAlwaysVisibleVectorSource() {
    const vectorSource = new VectorSource({
      features: [],
      wrapX: false,
    });

    // Monkey-patch this function to ensure the grid is always rendered even
    // when the origin/rotation points are outside the view extents
    vectorSource.getFeaturesInExtent = vectorSource.getFeatures;

    return vectorSource;
  }

  /**
   * @classdesc
   * OpenLayers SnappingGridControls Control.
   * @private
   */
  class SnappingGridControls extends Control {

    constructor(opts) {
      const options = opts || {};

      // Call the parent control constructor.
      super({
        element: document.createElement('div'),
        target: options.target,
      });

      const self = this;

      this.snappingGridFeature = options.snappingGridFeature;

      // Define the class name.
      const className = options.className || 'ol-snapgrid';

      // Add the button and CSS classes to the control element.
      const { element } = this;
      element.className = `${className} collapsed ${CLASS_UNSELECTABLE} ${CLASS_CONTROL}`;

      this.innerControlElements = {};

      function createControlElement(elementTag, name, builderFn) {
        const controlElem = document.createElement(elementTag);
        controlElem.className = `${className} ${name}`;
        builderFn.call(self, controlElem);
        self.innerControlElements[name] = controlElem;
        element.appendChild(controlElem);
      }

      createControlElement('button', 'activateButton', (button) => {
        button.innerHTML = '#';
        button.title = 'Enable Snapping Grid';
        button.type = 'button';

        button.addEventListener(EventType.CLICK, this.handleActivateButtonClick.bind(this), false);
      });

      createControlElement('input', 'xInput', (input) => {
        input.value = 5;
        input.type = 'number';
        input.step = 'any';
        input.classList.add('collabsible');

        input.addEventListener('change', self.handleXInputChanged.bind(this), false);
      });

      createControlElement('span', 'timesSymbol', (span) => {
        span.innerHTML = 'x';
        span.classList.add('collabsible');
      });

      createControlElement('input', 'yInput', (input) => {
        input.value = 5;
        input.type = 'number';
        input.step = 'any';
        input.classList.add('collabsible');

        input.addEventListener('change', self.handleYInputChanged.bind(this), false);
      });

      createControlElement('select', 'unitSelector', (unitSelector) => {
        function addUnit(value, selected) {
          const unitOption = document.createElement('option');
          unitOption.innerHTML = value;
          unitOption.value = value;
          unitOption.selected = selected;
          unitSelector.appendChild(unitOption);
        }

        addUnit('m');
        addUnit('ft');
        addUnit('in');

        unitSelector.value = (options.units === 'us' ? 'ft' : 'm');
        unitSelector.classList.add('collabsible');

        unitSelector.addEventListener('change', self.handleUnitsChanged.bind(this), false);
      });

      createControlElement('button', 'expandButton', (button) => {
        button.innerHTML = '>';
        button.title = 'Show dimensions inputs';
        button.type = 'button';
        button.classList.add('reverse-collabsible');

        button.addEventListener(EventType.CLICK, this.handleExpandButtonClick.bind(this), false);
      });

      createControlElement('button', 'collapseButton', (button) => {
        button.innerHTML = '<';
        button.title = 'Hide dimensions inputs';
        button.type = 'button';
        button.classList.add('collabsible');

        button.addEventListener(EventType.CLICK, this.handleCollapseButtonClick.bind(this), false);
      });

      createControlElement('button', 'clearButton', (button) => {
        button.innerHTML = 'X';
        button.title = 'Clear Snapping Grid';
        button.type = 'button';

        button.addEventListener(EventType.CLICK, this.handleClearButtonClick.bind(this), false);
      });

      this.vOriginStyle = new Style({
        image: new CircleStyle({
          radius: 2,
          fill: new Fill({ color: 'purple' }),
          stroke: new Stroke({ color: 'red', width: 1 }),
        }),
      });

      this.gridPointStyle = new Style({
        image: new CircleStyle({
          radius: 1,
          fill: new Fill({ color: 'white' }),
          stroke: new Stroke({ color: 'green', width: 1 }),
        }),
      });

      this.gridControlPointsVectorLayer = new VectorLayer({
        source: createAlwaysVisibleVectorSource(),
      });

      this.gridControlPointsVectorLayer.getSource().on('addfeature', this.handleAddGridControlFeature.bind(this));
      this.gridControlPointsVectorLayer.on('postrender', this.handleGridLayerPostRender.bind(this));
      document.addEventListener(EventType.KEYDOWN, this.handleEscape.bind(this), false);
    }

    /**
     * @inheritDoc
     * @api
     */
    setMap(map) {
      const oldMap = this.getMap();
      if (map === oldMap) {
        return;
      }
      if (oldMap) {
        oldMap.removeLayer(this.gridControlPointsVectorLayer);
      }
      super.setMap(map);

      if (map) {
        map.addLayer(this.gridControlPointsVectorLayer);

        map.getInteractions().on('add', (event) => {
          const interaction = event.element;

          // Reset our drawing interaction if any other interaction is added
          if (interaction !== this.drawSnappingOriginsInteraction
              && interaction !== this.snapInteraction) {
            this.resetDrawInteraction();
            this.innerControlElements.activateButton.disabled = true;
          }

          // Disable the activate button when there are other draw interactions enabled
          if (interaction === this.drawSnappingOriginsInteraction) {
            this.element.classList.add('active');
          }
        });

        // When Snap interactions are removed, unregister our grid feature
        map.getInteractions().on('remove', (event) => {
          const interaction = event.element;

          // Reset our drawing interaction pointer if anything causes it to be removed from the map
          if (interaction === this.drawSnappingOriginsInteraction) {
            this.drawSnappingOriginsInteraction = null;
            this.element.classList.remove('active');
          }

          // Enable the activate button when there are no other draw interactions enabled
          if (!this.mapHasOtherDrawInteractions()) {
            this.innerControlElements.activateButton.disabled = false;
          }

        });

      }
    }

    handleActivateButtonClick(event) {
      event.preventDefault();

      // This shouldn't happen since the activate button get disabled if there are other
      // draw interactions, but the behavior is poor enough that it is worth defending against
      if (this.mapHasOtherDrawInteractions()) {
        return;
      }

      this.activateSnappingGrid();
      this.element.classList.add('grid-active');
    }

    mapHasOtherDrawInteractions() {
      const otherDrawInteractions = this.getMap().getInteractions().getArray()
        .filter(interaction => typeof interaction.finishDrawing === 'function')
        .filter(interaction => interaction !== this.drawSnappingOriginsInteraction);

      return !!otherDrawInteractions.length;
    }

    handleUnitsChanged() {
      if (!this.gridDescription) {
        return;
      }

      this.gridDescription.xDim = this.getXDim();
      this.gridDescription.yDim = this.getYDim();

      this.getMap().render();
    }

    handleXInputChanged() {
      if (!this.gridDescription) {
        return;
      }

      this.gridDescription.xDim = this.getXDim();

      this.getMap().render();
    }

    handleYInputChanged() {
      if (!this.gridDescription) {
        return;
      }

      this.gridDescription.yDim = this.getYDim();

      this.getMap().render();
    }

    handleClearButtonClick(event) {
      event.preventDefault();

      this.gridDescription = null;
      this.snappingGridFeature.setGeometry(new MultiPoint([]));
      this.gridControlPointsVectorLayer.getSource().clear();

      this.element.classList.remove('grid-active');

      this.element.classList.remove('expanded');
      this.element.classList.add('collapsed');

      this.resetDrawInteraction();
    }

    handleExpandButtonClick(event) {
      event.preventDefault();

      this.element.classList.remove('collapsed');
      this.element.classList.add('expanded');
    }

    handleCollapseButtonClick(event) {
      event.preventDefault();

      this.element.classList.remove('expanded');
      this.element.classList.add('collapsed');
    }

    /**
     * Callback for escape key press. Deactivate grid control point draw interaction - if active.
     * @param {KeyboardEvent} event The event to handle
     * @private
     */
    handleEscape(event) {
      if (event.key === 'Escape') {
        this.resetDrawInteraction();
      }
    }

    resetDrawInteraction() {
      if (this.drawSnappingOriginsInteraction) {
        this.getMap().removeInteraction(this.drawSnappingOriginsInteraction);
        this.drawSnappingOriginsInteraction = null;
      }
      this.clearSnap();

      if (!this.gridDescription) {
        this.gridControlPointsVectorLayer.getSource().clear();
        this.element.classList.remove('grid-active');
        this.element.classList.remove('expanded');
        this.element.classList.add('collapsed');
      }
    }

    /**
     * Enable snapping grid.
     * @private
     */
    activateSnappingGrid() {
      this.gridDescription = null;
      this.resetDrawInteraction();
      this.snappingGridFeature.setGeometry(new MultiPoint([]));

      // Create the draw interaction and add it to the map.
      this.drawSnappingOriginsInteraction = new Draw({
        source: this.gridControlPointsVectorLayer.getSource(),
        type: 'Point',
      });

      this.getMap().addInteraction(this.drawSnappingOriginsInteraction);
      this.enableSnap();
    }

    /**
     * Enable snap interaction.
     * @private
     */
    enableSnap() {
      this.clearSnap();

      this.snapInteraction = new Snap({
        features: new Collection(),
      });

      // Load all vector layer features in the map and add them to the snap
      // interaction's feature collection (so they can be snapped to).
      forEachLayer(this.getMap().getLayerGroup(), (layer) => {
        if (typeof layer.getSource === 'function') {
          const source = layer.getSource();
          if (source && typeof source.getFeatures === 'function') {
            const features = source.getFeatures();
            if (source.getState() === 'ready' && features.length > 0) {
              features.forEach((feature) => {
                this.snapInteraction.addFeature(feature);
              });
            }
          }
        }
      });

      this.getMap().addInteraction(this.snapInteraction);
    }

    clearSnap() {
      if (this.snapInteraction) {
        this.getMap().removeInteraction(this.snapInteraction);
      }
    }

    handleAddGridControlFeature() {
      const map = this.getMap();

      const features = this.gridControlPointsVectorLayer.getSource().getFeatures();

      if (features.length !== 2) {
        return;
      }

      map.removeInteraction(this.drawSnappingOriginsInteraction);
      this.drawSnappingOriginsInteraction = null;

      const mapViewProjCode = map.getView().getProjection().getCode();

      const originPoint = features[0].getGeometry();
      const rotationAnchorPoint = features[1].getGeometry();

      function asEpsg4326Coords(point) {
        return point.clone()
          .transform(mapViewProjCode, 'EPSG:4326')
          .getCoordinates();
      }

      // ol.sphere.getDistance - a.k.a. 'getSphericalDistance' here - only seems to work correctly
      // in 'EPSG:4326'
      const cp1 = asEpsg4326Coords(originPoint);
      const cp2 = asEpsg4326Coords(rotationAnchorPoint);

      const cp3 = [cp1[0], cp2[1]];
      const cp4 = [cp2[0], cp1[1]];

      const len = getSphericalDistance(cp1, cp2);
      let rise = getSphericalDistance(cp1, cp3);
      let run = getSphericalDistance(cp1, cp4);

      // Potential bug: This approach to calculating the direction of the rise/run probably won't
      // work correctly when the coordinates wrap around.
      if (cp1[0] > cp2[0]) {
        run *= -1;
      }

      if (cp1[1] > cp2[1]) {
        rise *= -1;
      }

      const riseFactor = rise / len;
      const runFactor = run / len;

      this.gridDescription = {
        originPoint,
        riseFactor,
        runFactor,
        xDim: this.getXDim(),
        yDim: this.getYDim(),
      };
    }

    getXDim() {
      const conversionFactor = this.getSelectedUnitConversionFactor();

      return parseFloat(this.innerControlElements.xInput.value) * conversionFactor;
    }

    getYDim() {
      const conversionFactor = this.getSelectedUnitConversionFactor();

      return parseFloat(this.innerControlElements.yInput.value) * conversionFactor;
    }

    getSelectedUnitConversionFactor() {
      const unit = this.innerControlElements.unitSelector.value;

      if (unit === 'm') {
        return 1;
      }

      if (unit === 'ft') {
        return 1 / 3.28084;
      }

      if (unit === 'in') {
        return 0.0254;
      }

      throw new Error(`Unsupported unit selected: ${unit}`);
    }

    handleGridLayerPostRender(event) {
      const map = this.getMap();
      const { gridDescription } = this;

      if (!gridDescription) {
        return;
      }

      const viewExtent = map.getView().calculateExtent(map.getSize());

      const selectedOriginCoords = gridDescription.originPoint.getCoordinates();

      // Calculate orthogonal basis vectors for the grid
      let xBasisVector = [
        gridDescription.xDim * gridDescription.runFactor,
        gridDescription.xDim * gridDescription.riseFactor,
      ];
      let yBasisVector = [
        gridDescription.yDim * (-1) * gridDescription.riseFactor,
        gridDescription.yDim * gridDescription.runFactor,
      ];

      const localSphereNormalizationCoefficients = this
        .calculateLocalSphereNormalizationCoefficients(gridDescription.originPoint);

      xBasisVector = elementWiseVectorProduct(xBasisVector,
        localSphereNormalizationCoefficients);
      yBasisVector = elementWiseVectorProduct(yBasisVector,
        localSphereNormalizationCoefficients);

      const viewExtentCenter = getExtentCenter(viewExtent);

      const viewCenterCoordinateVector = getAlignedIntegerCoordinateVector(
        selectedOriginCoords,
        xBasisVector,
        yBasisVector,
        viewExtentCenter,
      );

      const vOriginCoords = addVectors(selectedOriginCoords, multiplyTwoByTwoMatrixByTwoVector(
        [xBasisVector, yBasisVector],
        viewCenterCoordinateVector,
      ));

      const vOrigin = new Point(vOriginCoords);

      const vGridExtentCoordinateVectors = getCoordinateVectorsToExtentCorners(
        vOriginCoords,
        xBasisVector,
        yBasisVector,
        viewExtent,
      );

      const gridPoints = calculateGridPoints(
        viewExtent,
        vOrigin,
        vGridExtentCoordinateVectors,
        xBasisVector,
        yBasisVector,
      );

      const gridPointsGeometry = new MultiPoint(gridPoints);

      this.snappingGridFeature.setGeometry(gridPointsGeometry);

      const vectorContext = getVectorContext(event);

      vectorContext.setStyle(this.gridPointStyle);

      vectorContext.drawGeometry(gridPointsGeometry);
    }

    calculateLocalSphereNormalizationCoefficients(origin) {
      const mapViewProjCode = this.getMap().getView().getProjection().getCode();

      function asEpsg4326Coords(point) {
        return point
          .transform(mapViewProjCode, 'EPSG:4326')
          .getCoordinates();
      }

      function translateCopy(point, deltaX, deltaY) {
        const p = point.clone();
        p.translate(deltaX, deltaY);
        return p;
      }

      const originCoords = asEpsg4326Coords(origin.clone());
      const testXCoords = asEpsg4326Coords(translateCopy(origin, 1, 0));
      const testYCoords = asEpsg4326Coords(translateCopy(origin, 0, 1));

      return [
        1 / getSphericalDistance(originCoords, testXCoords),
        1 / getSphericalDistance(originCoords, testYCoords),
      ];
    }

  }

  function getGridPoint(vOrigin, xi, yi, xBasisVector, yBasisVector) {
    const xVector = scaleVector(xBasisVector, xi);
    const yVector = scaleVector(yBasisVector, yi);

    const p = vOrigin.clone();
    p.setCoordinates(addVectors(vOrigin.getCoordinates(), xVector, yVector));

    return p;
  }

  // Assumes M is a 2x2 matrix as an array of columns
  function invertTwoByTwoMatrix(M) {
    const A = M[0][0];
    const B = M[0][1];
    const C = M[1][0];
    const D = M[1][1];

    const divisor = (A * D - B * C);

    return [
      [
        D / divisor,
        -B / divisor,
      ],
      [
        -C / divisor,
        A / divisor,
      ],
    ];
  }

  // Assumes M is a 2x2 matrix as an array of columns
  // Assumes V is an array of size two
  function multiplyTwoByTwoMatrixByTwoVector(M, V) {
    const A = M[0][0];
    const B = M[0][1];
    const C = M[1][0];
    const D = M[1][1];

    const E = V[0];
    const F = V[1];

    return [
      A * E + C * F,
      B * E + D * F,
    ];
  }

  function getCoordinateVector(bx, by, Z) {
    const I = invertTwoByTwoMatrix([bx, by]);

    return multiplyTwoByTwoMatrixByTwoVector(I, Z);
  }

  function getIntegerCoordinateVector(bx, by, Z, roundingFunction) {
    const round = roundingFunction || Math.round;

    const cv = getCoordinateVector(bx, by, Z);

    return [round(cv[0]), round(cv[1])];
  }

  function subtractVectors(va, vb) {
    return [va[0] - vb[0], va[1] - vb[1]];
  }

  function addVectors(va, vb, vc) {
    if (vc) {
      return [va[0] + vb[0] + vc[0], va[1] + vb[1] + vc[1]];
    }
    return [va[0] + vb[0], va[1] + vb[1]];
  }

  function scaleVector(v, c) {
    return [v[0] * c, v[1] * c];
  }

  function elementWiseVectorProduct(va, vb) {
    return [va[0] * vb[0], va[1] * vb[1]];
  }

  /*
   * Get the integer coordinate vector between a given origin and point Z in terms of the basis
   * vectors [bx, by].
   */
  function getAlignedIntegerCoordinateVector(origin, bx, by, Z, roundingFunction) {
    const zOffset = subtractVectors(Z, origin);

    return getIntegerCoordinateVector(bx, by, zOffset, roundingFunction);
  }

  function getCoordinateVectorsToExtentCorners(origin, bx, by, extent) {
    return [
      getAlignedIntegerCoordinateVector(origin, bx, by, [extent[0], extent[1]], Math.ceil),
      getAlignedIntegerCoordinateVector(origin, bx, by, [extent[2], extent[3]], Math.ceil),
      getAlignedIntegerCoordinateVector(origin, bx, by, [extent[0], extent[3]], Math.ceil),
      getAlignedIntegerCoordinateVector(origin, bx, by, [extent[2], extent[1]], Math.ceil),
    ];
  }

  function calculateGridPoints(
    viewExtent,
    vOrigin,
    vGridExtentCoordinateVectors,
    xBasisVector,
    yBasisVector,
  ) {
    const x1 = vGridExtentCoordinateVectors[0][0];
    const y1 = vGridExtentCoordinateVectors[0][1];

    const x2 = vGridExtentCoordinateVectors[1][0];
    const y2 = vGridExtentCoordinateVectors[1][1];

    const x3 = vGridExtentCoordinateVectors[2][0];
    const y3 = vGridExtentCoordinateVectors[2][1];

    const x4 = vGridExtentCoordinateVectors[3][0];
    const y4 = vGridExtentCoordinateVectors[3][1];

    const minX = Math.min(x1, x2, x3, x4);
    const minY = Math.min(y1, y2, y3, y4);

    const maxX = Math.max(x1, x2, x3, x4);
    const maxY = Math.max(y1, y2, y3, y4);

    const deltaX = maxX - minX;
    const deltaY = maxY - minY;

    const incrementX = Math.max(1, Math.floor(deltaX / MAX_POINTS_PER_SIDE));
    const incrementY = Math.max(1, Math.floor(deltaY / MAX_POINTS_PER_SIDE));

    const gridPointCoords = [];

    for (let xi = minX; xi <= maxX; xi += incrementX) {
      for (let yi = minY; yi <= maxY; yi += incrementY) {

        const gridPoint = getGridPoint(vOrigin, xi, yi, xBasisVector, yBasisVector);

        if (gridPoint.intersectsExtent(viewExtent)) {
          gridPointCoords.push(gridPoint.getCoordinates());
        }

      }
    }

    return gridPointCoords;
  }

}());
