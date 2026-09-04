CREATE ROLE wagering_app LOGIN PASSWORD 'wagering_app';

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO wagering_app;
