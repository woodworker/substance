s.views.Node.define('/type/map', {

  className: 'content-node map',

  initialize: function () {
    s.views.Node.prototype.initialize.apply(this, arguments);
  },

  render: function () {
    s.views.Node.prototype.render.apply(this);

    var mapEditor = $(s.util.tpl('map_editor', this.model)).appendTo(this.contentEl);

    function initMap() {
      var map = new L.Map(this.model.html_id + '_viewport', {
        layers: new L.TileLayer('http://a.tiles.mapbox.com/v3/mapbox.mapbox-streets/{z}/{x}/{y}.png', {}),
        center: new L.LatLng(51.505, -0.09),
        zoom: 13,
        attributionControl: false
      });

      // create a marker in the given location and add it to the map
      var marker = new L.Marker(new L.LatLng(51.5, -0.09));
      map.addLayer(marker);
      marker.bindPopup("Your POI").openPopup();
    }
    _.delay(_.bind(initMap, this), 20);

    return this;
  }
});