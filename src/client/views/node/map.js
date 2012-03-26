s.views.Node.define('/type/map', {

  className: 'content-node map',

  initialize: function () {
    s.views.Node.prototype.initialize.apply(this, arguments);
  },

  render: function () {
    var that = this;
    s.views.Node.prototype.render.apply(this);

    var mapEditor = $(s.util.tpl('map_editor', this.model)).appendTo(this.contentEl);

    function initMap() {
      var map = new L.Map(this.model.html_id + '_viewport', {
        layers: new L.TileLayer('http://a.tiles.mapbox.com/v3/mapbox.mapbox-streets/{z}/{x}/{y}.png', {}),
        center: new L.LatLng(that.model.get('latitude'), that.model.get('longitude')),
        zoom: that.model.get('zoom'),
        attributionControl: false
      });

      map.on('move', function(e) {
        var center = map.getCenter();
        that.model.set({
          latitude: center.lat,
          longitude: center.lng,
          zoom: map.getZoom()
        });
      });

      var annotator = new Pinpoint(map, {
        pins: that.model.get('annotations'),
        update: function(pins) {
          that.model.set({annotations: pins});
        }
      });
    }
    _.delay(_.bind(initMap, this), 20);

    return this;
  }
});