s.views.Node.define('/type/map', {

  className: 'content-node map',

  initialize: function () {
    s.views.Node.prototype.initialize.apply(this, arguments);
  },

  render: function () {
    s.views.Node.prototype.render.apply(this);

    var mapEditor = $(s.util.tpl('map_editor', this.model)).appendTo(this.contentEl);

    // Define the map to use from MapBox
    var url = 'http://api.tiles.mapbox.com/v3/mapbox.mapbox-streets.jsonp';

    // Get metadata about the map from MapBox
    wax.tilejson(url,_.bind(function(tilejson) {
        // Make a new Leaflet map in your container div
        var map = new L.Map(this.model.html_id + "_viewport")
          
        // Center the map on Washington, DC, at zoom 15
        .setView(new L.LatLng(this.model.get('latitude'), this.model.get('longitude')), 15)

        // Add MapBox Streets as a base layer
        .addLayer(new wax.leaf.connector(tilejson))

        .on('moveend', _.bind(function() {
          var center = map.getCenter();
          this.model.set({
            latitude: center.lat,
            longitude: center.lng,
            zoom: map.getZoom()
          });
        }, this));
    }, this));
    return this;
  }
});