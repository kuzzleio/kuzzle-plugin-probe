var
  should = require('should'),
  sinon = require('sinon'),
  proxyquire = require('proxyquire').noPreserveCache(),
  lolex = require('lolex'),
  StubContext = require('./stubs/context.stub'),
  StubElasticsearch = require('./stubs/elasticsearch.stub'),
  longTimeout = require('long-timeout');

require('sinon-as-promised');

describe('#Testing index file', () => {
  var
    Plugin,
    plugin,
    esStub,
    sandbox,
    fakeContext,
    setIntervalStub;

  before(() => {
    sandbox = sinon.sandbox.create();
  });

  beforeEach(() => {
    sandbox.reset();

    setIntervalStub = sandbox.spy(longTimeout, 'setInterval');
    esStub = new StubElasticsearch();
    Plugin = proxyquire('../lib/index', {
      'elasticsearch': {
        Client: esStub
      },
      'long-timeout': longTimeout
    });

    plugin = new Plugin();
    esStub.reset();
    fakeContext = new StubContext();
  });

  afterEach(() => {
    setIntervalStub.restore();
  });

  it('should throw an error if no config is provided', () => {
    should(() => plugin.init({}, {}, false)).throw(/no configuration provided/);
    should(() => plugin.init(undefined, {}, false)).throw(/no configuration provided/);
    should(() => plugin.init(null, {}, false)).throw(/no configuration provided/);
  });

  it('should throw an error if no target database is configured', () => {
    should(() => plugin.init({foo: 'bar'}, {}, false)).throw(/no target database set/);
    should(() => plugin.init({databases: 'foo:bar'}, {}, false)).throw(/no target database set/);
    should(() => plugin.init({databases: []}, {}, false)).throw(/no target database set/);
  });

  it('should throw an error if no storage index is configured', () => {
    should(() => plugin.init({databases: ['foo:bar']}, {}, false)).throw(/no storage index/);
    should(() => plugin.init({databases: ['foo:bar'], storageIndex: 1}, {}, false)).throw(/no storage index/);
    should(() => plugin.init({databases: ['foo:bar'], storageIndex: ''}, {}, false)).throw(/no storage index/);
  });
  
  it('should enter dummy mode if no probe is set', () => {
    plugin.init({
      databases: ['foo'],
      storageIndex: 'bar'
    }, fakeContext, false);

    should(plugin.dummy).be.true();
    should(plugin.probes).be.empty();
    should(plugin.client).be.null();

    plugin.init({
      databases: ['foo'],
      storageIndex: 'bar',
      probes: {}
    }, fakeContext, false);

    should(plugin.dummy).be.true();
    should(plugin.probes).be.empty();
    should(plugin.client).be.null();
  });

  it('should enter dummy mode when asked to', () => {
    plugin.init({
      databases: ['foo'],
      storageIndex: 'bar',
      probes: {
        foo: {
          type: 'monitor',
          hooks: ['foo:bar']
        }
      }
    }, fakeContext, true);

    should(plugin.dummy).be.true();
    should(plugin.probes).not.be.empty();
    should(plugin.client).be.null();
  });

  it('should prepare the DSL at startup', () => {
    var
      stubRegister = sinon.stub(),
      stubCreateFilterId = sinon.stub().returns('foobar');

    fakeContext = {
      constructors: {
        Dsl: function () {
          return {
            register: stubRegister,
            createFilterId: stubCreateFilterId
          };
        }
      }
    };

    plugin.init({
      databases: ['foo'],
      storageIndex: 'bar',
      probes: {
        foo: {
          type: 'watcher',
          index: 'foo',
          collection: 'bar',
          filter: {}
        }
      }
    }, fakeContext, false);

    should(stubCreateFilterId.calledOnce).be.true();
    should(stubCreateFilterId.calledWith('foo', 'bar', {})).be.true();
    should(stubRegister.calledOnce).be.true();
    should(stubRegister.calledWith('foobar', 'foo', 'bar', {})).be.true();
  });

  it('should ignore probes without any type defined', () => {
    plugin.init({
      databases: ['foo'],
      storageIndex: 'bar',
      probes: {
        badProbe: {
          index: 'foo',
          collection: 'bar',
          hooks: ['foo:bar', 'data:beforePublish']
        }
      }
    }, fakeContext, false);

    should(plugin.probes.badProbe).be.undefined();
  });

  it('should initialize the hooks list properly', () => {
    plugin.init({
      databases: ['foo'],
      storageIndex: 'bar',
      probes: {
        foo: {
          type: 'monitor',
          hooks: ['foo:bar', 'data:beforePublish']
        },
        bar: {
          type: 'counter',
          increasers: ['bar:baz', 'foo:bar', 'foo:bar'],
          decreasers: ['baz:qux']
        },
        baz: {
          type: 'counter',
          increasers: ['baz:qux', 'data:beforePublish'],
          decreasers: ['foo:bar']
        },
        qux: {
          type: 'watcher',
          index: 'foo',
          collection: 'bar'
        }
      }
    }, fakeContext, false);

    should(plugin.dummy).be.false();
    should(plugin.hooks['foo:bar']).match(['monitor', 'counter']);
    should(plugin.hooks['bar:baz']).be.eql('counter');
    should(plugin.hooks['baz:qux']).be.eql('counter');
    should(plugin.hooks['data:beforePublish'].sort()).be.eql(['counter', 'monitor', 'watcher']);
    should(plugin.hooks['data:beforeCreate']).be.eql('watcher');
  });
  
  it('should not reset the measure if an error during saving occurs', (done) => {
    var
      clock = lolex.install(),
      pluginConfig = {
        databases: ['foo'],
        storageIndex: 'bar',
        probes: {
          foo: {
            type: 'monitor',
            hooks: ['foo:bar'],
            interval: '1s'
          }
        }
      };

    plugin.init(pluginConfig, fakeContext)
      .then(() => {
        sinon.stub(plugin.client, 'create').rejects(new Error('foobar'));

        plugin.monitor('foo:bar');
        should(plugin.client.create.called).be.false();

        clock.next();
        should(plugin.client.create.calledOnce).be.true();
        should(plugin.client.create.calledWithMatch({
          index: 'bar',
          type: 'foo',
          body: {
            'foo:bar': 1
          }
        })).be.true();

        clock.uninstall();
        plugin.client.create.restore();
        setTimeout(() => {
          try {
            should(plugin.measures.foo['foo:bar']).be.eql(1);
          } catch (e) {
            return done(e);
          }

          done();
        }, 0);
      })
      .catch(err => done(err));
  });

  it('should call setInterval when an interval is set on a valid probe', (done) => {
    plugin.init({
      databases: ['foo'],
      storageIndex: 'storageIndex',
      probes: {
        fooprobe: {
          type: 'watcher',
          index: 'foo',
          collection: 'bar',
          collects: ['foo'],
          interval: '1ms'
        }
      }
    }, fakeContext);

    setTimeout(() => {
      should(setIntervalStub.calledOnce).be.true();
      done();
    }, 20);
  });

  it('should not call setInterval when an error occures during collection creation', (done) => {
    plugin.init({
      databases: ['foo'],
      storageIndex: 'storageIndex',
      probes: {
        fooprobe: {
          type: 'watcher',
          index: 'foo',
          collection: 'bar',
          collects: ['foo'],
          interval: '1ms'
        }
      }
    }, fakeContext);

    plugin.client.indices.putMapping.rejects(new Error('an Error'));

    setTimeout(() => {
      should(setIntervalStub.callCount).be.eql(0);
      done();
    }, 20);
  });
});
