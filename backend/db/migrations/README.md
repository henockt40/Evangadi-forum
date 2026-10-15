# Database migrations

For a database created from `schema.sql`, the profile, saved question, and answer like tables already exist.

For an existing database, apply `002_social_profile_features.sql` once before starting the updated application. The migration adds the profile image column and creates the two social feature tables.
