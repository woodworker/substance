var Node = Backbone.View.extend({

  className: 'content-node',

  attributes: {
    draggable: 'false'
  },

  events: {
    'click .toggle-comments': 'toggleComments',
    'click .remove-node': 'removeNode',
    'click .toggle-move-node': 'toggleMoveNode'
  },

  initialize: function (options) {
    this.parent = options.parent;
    this.level = options.level;
    this.comments = new Node.Comments({ model: this.model.get('comments') });
  },

  toggleComments: function () { this.comments.toggle(); },
  removeNode: function () {
    removeChild(this.parent, this.model);
  },
  toggleMoveNode: function () {},

  readonly: function () {},
  readwrite: function () {},
  select: function () {
    $(this.el).addClass('selected');
  },
  deselect: function () {
    $(this.el).removeClass('selected');
  },

  render: function () {
    $('<div class="content-node-outline"><div class="cursor"><span></span></div></div>').appendTo(this.el);
    this.operationsEl = $(
      '<div class="operations">' +
        '<a href="/" class="toggle-comments sticky" title="Toggle comments for Section"><span>' + this.model.get('comment_count') + '</span></a>' +
        '<a href="/" class="remove-node" title="Remove Node"></a>' +
        '<a href="/" class="toggle-move-node" title="Move Section — Use placeholders as targets"></a>' +
      '</div>'
    ).appendTo(this.el);
    //{{#edit}}<div class="pilcrow">&#182;</div>{{/edit}}
    this.contentEl = $('<div class="content" />').appendTo(this.el);
    this.commentsEl = $(this.comments.render().el).appendTo(this.el);
    return this;
  }

}, {

  nodes: {},

  define: function (type, name, protoProps, classProps) {
    protoProps.name = classProps.name = name;
    return this.nodes[type] = this.extend(protoProps, classProps);
  },

  create: function (options) {
    var model = options.model;
    return new this.nodes[model.type](options);
  }

});


Node.Comments = Backbone.View.extend({

  className: 'comments-wrapper',

  initialize: function () {},

  toggle: function () {
    $(this.el).toggleClass('expanded');
  },

  render: function () {
    return this;
  }

});


/*
  <div class="handle">
    <a href="/">--&gt; INSERT</a>
  </div>
  <div class="actions">
    <div class="placeholder insert">Insert Content</div>
    <div class="placeholder move">Move</div>
    <% actions.each(function(action) { %>
        <% if (action.length === 0) return; %>
        <% if (action.length === 1) { %>
          <% _.each(action, function(v) { %>
            <span>
            <a href="/" type="<%= v.nodeType %>" destination="<%= destination %>" node="<%= v.node %>" parent="<%= v.parentNode %>" class="add add_<%= v.insertionType %>"><%= v.nodeTypeName %></a>
            </span>
          <% }); %>
        <% } else { %>
          <span class="container add">
          <%= action[0].nodeTypeName %>
          <div>
            <% _.each(action, function(v) { %>
              <a href="/" type="<%= v.nodeType %>" destination="<%= destination %>" node="<%= v.node %>" parent="<%= v.parentNode %>" class="add add_<%= v.insertionType %>">Level <%= v.level %></a>
            <% }); %>
          </div>
          </span>
        <% } %>
    <% }); %>
    
    <div class="move-targets">
      <!-- container node targets  -->
      <% _.each(path, function(n, index) { %>
        <span><a class="move-node container-node" href="/" node="<%= n._id %>" destination="<%= destination %>" level="<%= (index+1) %>"><!--<%= destination %>--> Here <!--&quot;<%= ContentNode.getTeaser(n).trim() %>&quot;--> at level <%= n.level %></a></span>
      <% }); %>
      
      <!-- allow child insertion for empty container nodes -->
      <% if (insertion_type === 'child' && node.level < 3) { %>
        <span><a class="move-node container-node <%= insertion_type %>" href="/" node="<%= node._id %>" destination="<%= destination %>"><!--Inside--> Here <!--&quot;<%= ContentNode.getTeaser(node).trim() %>&quot;--> at level <%= (node.level+1) %></a></span>
      <% } %>
      
      <!-- leaf node target  -->
      <span><a class="move-node leaf-node <%= insertion_type %>" href="/" node="<%= node._id %>" destination="<%= destination %>"><!--<%= insertion_type == "sibling" ? destination : "inside" %>--> Here <!--&quot;<%= ContentNode.getTeaser(node).trim() %>&quot;--></a></span>
    </div>
    
    <span class="message">
      
    </span>
    <br class="clear"/>
  </div>
*/


Node.Controls = Backbone.View.extend({

  className: 'controls',

  events: {
    'click .add': 'insert'
  },

  initialize: function (options) {
    this.position = options.position;
  },

  insert: function (event) {
    event.preventDefault();
    var type = $(event.target).attr('data-type');
    createNode(type, this.position);
  },

  render: function () {
    var actions = $('<div class="actions" />').appendTo(this.el);
    $('<div class="placeholder insert" />').text("Insert Content").appendTo(actions);
    _.each(possibleChildNodes(this.model), function (type) {
      var name = type;
      $('<span><a href="/" data-type="' + type + '" class="add add_child">' + name + '</a></span>').appendTo(actions);
    });
    $('<br class="clear" />').appendTo(actions);
    return this;
  }

});


Node.NodeList = Backbone.View.extend({

  initialize: function (options) {
    var childViews = this.childViews = [];
    this.model.get('children').each(function (child) {
      childViews.push(Node.create({ model: child, level: options.level + 1 }));
    });
  },

  eachChildView: function (fn) {
    _.each(this.childViews, fn);
  },

  readonly: function () {
    this.eachChildView(function (childView) {
      childView.readonly();
    });
  },

  readwrite: function () {
    this.eachChildView(function (childView) {
      childView.readwrite();
    });
  },

  //select: function () {}

  deselect: function () {
    this.eachChildView(function (childView) {
      childView.deselect();
    });
  },

  render: function () {
    var self = this;
    this.eachChildView(function (childView) {
      $(childView.render().el).appendTo(self.el);
      var controls = new Node.Controls({
        model: self.model,
        position: { parent: self.model, after: childView.model }
      });
      $(controls.render().el).appendTo(self.el);
    });
    return this;
  }

});